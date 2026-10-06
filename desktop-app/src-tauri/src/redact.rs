//! PII masking and secret scrubbing. Dependency-free on purpose (no regex crate).
//! Used by the CRM adapter (masking before data reaches the model) and by the trace (defence in depth).
use serde_json::Value;

/// Phone -> `***` + last two digits. Fewer than 3 digits -> `***`.
pub fn mask_phone(s: &str) -> String {
    let d: Vec<char> = s.chars().filter(|c| c.is_ascii_digit()).collect();
    if d.len() < 3 {
        return "***".into();
    }
    format!("***{}{}", d[d.len() - 2], d[d.len() - 1])
}

/// `jean.dupont@gmail.com` -> `j***@gmail.com`.
pub fn mask_email(s: &str) -> String {
    match s.split_once('@') {
        Some((l, d)) if !l.is_empty() => format!("{}***@{}", l.chars().next().unwrap(), d),
        _ => "***".into(),
    }
}

fn is_local(c: char) -> bool {
    c.is_ascii_alphanumeric() || "._%+-".contains(c)
}
fn is_dom(c: char) -> bool {
    c.is_ascii_alphanumeric() || ".-".contains(c)
}

fn mask_emails(s: &str) -> String {
    let ch: Vec<char> = s.chars().collect();
    let mut out: Vec<char> = Vec::with_capacity(ch.len());
    let mut i = 0;
    while i < ch.len() {
        if ch[i] == '@' {
            let mut ls = out.len();
            while ls > 0 && is_local(out[ls - 1]) {
                ls -= 1;
            }
            let mut j = i + 1;
            while j < ch.len() && is_dom(ch[j]) {
                j += 1;
            }
            while j > i + 1 && ch[j - 1] == '.' {
                j -= 1;
            }
            let dom: String = ch[i + 1..j].iter().collect();
            if ls < out.len() && dom.contains('.') && !dom.starts_with('.') {
                let first = out[ls];
                out.truncate(ls);
                out.push(first);
                out.extend("***@".chars());
                out.extend(dom.chars());
                i = j;
                continue;
            }
        }
        out.push(ch[i]);
        i += 1;
    }
    out.into_iter().collect()
}

fn starts_with_iso_date(run: &[char]) -> bool {
    run.len() >= 10
        && run[..10].iter().enumerate().all(|(k, c)| if k == 4 || k == 7 { *c == '-' } else { c.is_ascii_digit() })
}

fn mask_phones(s: &str) -> String {
    let ch: Vec<char> = s.chars().collect();
    let n = ch.len();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < n {
        let starts = ch[i].is_ascii_digit() || (ch[i] == '+' && i + 1 < n && ch[i + 1].is_ascii_digit());
        if !starts {
            out.push(ch[i]);
            i += 1;
            continue;
        }
        // Maximal run of digits and separators; `end` = just after the last digit.
        let (mut j, mut end, mut digits) = (i + 1, i + 1, ch[i].is_ascii_digit() as usize);
        while j < n {
            let c = ch[j];
            if c.is_ascii_digit() {
                digits += 1;
                j += 1;
                end = j;
            } else if " .-()".contains(c) {
                j += 1;
            } else {
                break;
            }
        }
        let run = &ch[i..end];
        let prev_ok = i == 0
            || !(ch[i - 1].is_alphanumeric() || ch[i - 1] == '_' || (ch[i - 1] == '-' && i >= 2 && ch[i - 2].is_alphabetic()));
        let next_ok = end >= n || !(ch[end].is_alphabetic() || ch[end] == '_');
        // Not an ISO date/timestamp, not glued to an identifier (uuid segments, slugs).
        if (9..=15).contains(&digits) && prev_ok && next_ok && !starts_with_iso_date(run) {
            let d: String = run.iter().filter(|c| c.is_ascii_digit()).collect();
            out.push_str(&format!("***{}", &d[d.len() - 2..]));
        } else {
            out.extend(run.iter());
        }
        i = end;
    }
    out
}

/// Masks emails and phone numbers found in free text.
pub fn mask_text(s: &str) -> String {
    mask_phones(&mask_emails(s))
}

/// Removes the given literal secrets plus anything that looks like a token (`Bearer x`, `sk-...`, JWT `eyJ...`).
pub fn scrub_secrets(s: &str, secrets: &[String]) -> String {
    let mut out = s.to_string();
    for sec in secrets.iter().filter(|x| x.len() >= 8) {
        out = out.replace(sec.as_str(), "[secret]");
    }
    let ch: Vec<char> = out.chars().collect();
    let tok = |c: char| c.is_ascii_alphanumeric() || "_-.".contains(c);
    let mut res = String::with_capacity(out.len());
    let mut i = 0;
    while i < ch.len() {
        if tok(ch[i]) && (i == 0 || !tok(ch[i - 1])) {
            let mut j = i;
            while j < ch.len() && tok(ch[j]) {
                j += 1;
            }
            let w: String = ch[i..j].iter().collect();
            if w.len() >= 20 && (w.starts_with("eyJ") || w.starts_with("sk-")) {
                res.push_str("[secret]");
            } else {
                res.push_str(&w);
            }
            i = j;
        } else {
            res.push(ch[i]);
            i += 1;
        }
    }
    // Header-style leftovers: "Bearer abc" where abc is shorter than the heuristics above.
    let mut final_s = String::with_capacity(res.len());
    let mut rest = res.as_str();
    while let Some(p) = rest.find("Bearer ") {
        final_s.push_str(&rest[..p]);
        final_s.push_str("Bearer [secret]");
        let after = &rest[p + 7..];
        let cut = after.find(|c: char| !(tok(c) || c == '=' || c == '+' || c == '/')).unwrap_or(after.len());
        rest = &after[cut..];
    }
    final_s.push_str(rest);
    final_s
}

/// Full redaction used for traces: secrets first, then PII.
pub fn redact(s: &str, secrets: &[String]) -> String {
    mask_text(&scrub_secrets(s, secrets))
}

pub fn redact_value(v: &mut Value, secrets: &[String]) {
    match v {
        Value::String(s) => *s = redact(s, secrets),
        Value::Array(a) => a.iter_mut().for_each(|x| redact_value(x, secrets)),
        Value::Object(m) => m.values_mut().for_each(|x| redact_value(x, secrets)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phones_and_emails() {
        assert_eq!(mask_phone("+212 612-345-678"), "***78");
        assert_eq!(mask_phone("1"), "***");
        assert_eq!(mask_email("jean.dupont@gmail.com"), "j***@gmail.com");
        assert_eq!(mask_text("Appelez +212 6 12 34 56 78 svp"), "Appelez ***78 svp");
        assert_eq!(mask_text("tel 0612345678."), "tel ***78.");
        assert_eq!(mask_text("écrire à a.b@x.ma, merci"), "écrire à a***@x.ma, merci");
        assert!(!mask_text("a@b.com / 0612345678").contains("0612345678"));
    }

    #[test]
    fn leaves_dates_ids_and_counts_alone() {
        for keep in [
            "visite 2026-10-06T09:00:00.000Z ok",
            "2026-10-06 09:00:00",
            "id 12345678-1234-5678-9abc-123456789012",
            "il y a 20 clients, 100 visites",
            "ref VIS-20261006123456",
            "budget 1500000",
            "email sans arobase a@b",
        ] {
            assert_eq!(mask_text(keep), keep, "{keep}");
        }
    }

    #[test]
    fn secrets_are_scrubbed() {
        let key = "sk-or-v1-abcdef0123456789abcdef";
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV";
        let s = scrub_secrets(&format!("k={key} t={jwt} Authorization: Bearer abc.def short"), &["MYSECRET1234".into()]);
        assert!(!s.contains("abcdef0123") && !s.contains("eyJ") && !s.contains("abc.def"), "{s}");
        assert_eq!(scrub_secrets("x MYSECRET1234 y", &["MYSECRET1234".into()]), "x [secret] y");
        let mut v = serde_json::json!({"a": ["0612345678", {"b": key}]});
        redact_value(&mut v, &[]);
        assert_eq!(v.to_string(), r#"{"a":["***78",{"b":"[secret]"}]}"#);
    }
}

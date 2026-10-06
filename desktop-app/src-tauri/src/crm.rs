//! Read-only CRM adapter. The ONLY code that holds the CRM credential and talks to the workspace origin.
//!
//! Reads go through GraphQL with an explicit field selection: Twenty denies a whole REST read when the role
//! lacks permission on any field of the object, and REST cannot select fields. No REST path is used here.
//!
//! Auth (UNCERTAIN, isolated in `extract_token` and `Crm::headers`): the CRM web client authenticates API
//! calls with `Authorization: Bearer <access token>` where the token comes from the `tokenPair` cookie
//! (JSON `{accessOrWorkspaceAgnosticToken:{token}}`). Evidence in this repo: the deployed control-app bundle sends
//! exactly that Bearer with `credentials: same-origin`. Not proven offline: that the raw cookie alone is
//! accepted, that `tokenPair` is readable (not HttpOnly) in the webview cookie jar, or its exact JSON shape.
use reqwest::{redirect::Policy, Client};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::Url;

use crate::redact::{mask_email, mask_phone, mask_text, scrub_secrets};

pub const TOOL_NAMES: [&str; 5] = ["count_records", "list_records", "find_client", "list_visits", "list_conversations_needing_reply"];
const MAX_RESULT_BYTES: usize = 6000;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_TEXT_CHARS: usize = 200;
const VISIT_STATUSES: [&str; 6] = ["REQUESTED", "NEEDS_CONFIRMATION", "SCHEDULED", "COMPLETED", "CANCELLED", "NO_SHOW"];

// ---- auth ---------------------------------------------------------------------------------------

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let (mut out, mut i) = (Vec::with_capacity(b.len()), 0);
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = ((b[i + 1] as char).to_digit(16), (b[i + 2] as char).to_digit(16)) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Access token out of the cookie jar (name/value pairs). None = signed out.
pub fn extract_token(cookies: &[(String, String)]) -> Option<String> {
    let raw = &cookies.iter().find(|(n, _)| n == "tokenPair")?.1;
    let v: Value = serde_json::from_str(&percent_decode(raw)).ok()?;
    let t = v
        .pointer("/accessOrWorkspaceAgnosticToken/token")
        .or_else(|| v.pointer("/accessToken/token"))?
        .as_str()?;
    // Header-safe: printable ASCII, no spaces, bounded.
    (!t.is_empty() && t.len() <= 4096 && t.chars().all(|c| c.is_ascii_graphic())).then(|| t.to_string())
}

// ---- tool schemas (sent to the model; fixed for the whole run) ------------------------------------

pub fn tool_specs() -> Value {
    let objects = json!({"type":"string","enum": OBJECTS.iter().map(|o| o.plural).collect::<Vec<_>>()});
    let f = |name: &str, desc: &str, params: Value| json!({"type":"function","function":{"name":name,"description":desc,"parameters":params}});
    json!([
        f("count_records", "Compte les enregistrements d'un objet du CRM.",
          json!({"type":"object","properties":{"object":objects},"required":["object"],"additionalProperties":false})),
        f("list_records", "Liste au plus 20 enregistrements d'un objet avec les champs demandés (champs sensibles masqués).",
          json!({"type":"object","properties":{"object":objects,
            "limit":{"type":"integer","minimum":1,"maximum":20},
            "fields":{"type":"array","items":{"type":"string"},"maxItems":10}},
            "required":["object"],"additionalProperties":false})),
        f("find_client", "Cherche un client par référence (identifiant externe) OU par nom (recherche partielle).",
          json!({"type":"object","properties":{"reference":{"type":"string","maxLength":80},"name":{"type":"string","maxLength":80}},"additionalProperties":false})),
        f("list_visits", "Liste les visites entre deux dates (AAAA-MM-JJ, UTC), filtre de statut optionnel.",
          json!({"type":"object","properties":{"from":{"type":"string"},"to":{"type":"string"},
            "status":{"type":"string","enum":VISIT_STATUSES}},"required":["from","to"],"additionalProperties":false})),
        f("list_conversations_needing_reply", "Liste les conversations WhatsApp en attente d'une réponse du personnel.",
          json!({"type":"object","properties":{},"additionalProperties":false})),
    ])
}

// ---- objects allowlist ------------------------------------------------------------------------------

struct Obj {
    plural: &'static str,
    /// Scalar fields only (rich-text/composite fields need sub-selections and are excluded on purpose).
    fields: &'static [&'static str],
    default: &'static [&'static str],
}

const OBJECTS: [Obj; 6] = [
    Obj { plural: "agencyClients", fields: &["id", "createdAt", "updatedAt", "name", "phone", "email", "temperature", "source", "platformWorkspaceId", "externalId", "whatsappConsent", "marketingEmailConsent", "consentSource", "consentAt", "unsubscribedAt"], default: &["id", "name", "temperature", "source"] },
    Obj { plural: "agencyDemands", fields: &["id", "createdAt", "label", "status", "city", "budgetMin", "budgetMax", "propertyType", "assignedUserId", "routingPolicy", "sourceListingId", "externalId"], default: &["id", "label", "status", "city", "budgetMin", "budgetMax"] },
    Obj { plural: "agencyVisits", fields: &["id", "createdAt", "reference", "status", "requestedAt", "scheduledAt", "listingReference", "clientPhone", "assignedAgent", "source"], default: &["id", "reference", "status", "scheduledAt", "listingReference", "assignedAgent"] },
    Obj { plural: "whatsAppConversations", fields: &["id", "createdAt", "threadId", "clientPhone", "status", "direction", "lastMessage", "lastMessageAt", "syncState", "externalId"], default: &["id", "status", "direction", "lastMessageAt"] },
    Obj { plural: "aiActionSuggestions", fields: &["id", "createdAt", "title", "category", "status", "priority", "clientRef", "propertyRef", "visitRef", "approvedAt", "externalId", "executionId", "executionStartedAt", "executionFinishedAt"], default: &["id", "title", "category", "status", "priority", "createdAt"] },
    // qrCode and the visit `token` are never selectable.
    Obj { plural: "botSessions", fields: &["id", "name", "status", "phoneNumber", "lastSeenAt", "paused"], default: &["id", "name", "status", "lastSeenAt", "paused"] },
];

fn object(name: &str) -> Result<&'static Obj, String> {
    OBJECTS.iter().find(|o| o.plural == name).ok_or_else(|| format!("objet non autorisé : {}", name.chars().take(40).collect::<String>()))
}

fn is_phone_field(f: &str) -> bool {
    matches!(f, "phone" | "clientPhone" | "phoneNumber")
}

// ---- argument validation (strict: unknown keys rejected) ---------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CountArgs {
    object: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListArgs {
    object: String,
    limit: Option<i64>,
    #[serde(default)]
    fields: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FindArgs {
    reference: Option<String>,
    name: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VisitArgs {
    from: String,
    to: String,
    status: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoArgs {}

fn parse<T: for<'de> Deserialize<'de>>(args: &Value) -> Result<T, String> {
    serde_json::from_value(args.clone()).map_err(|e| format!("arguments invalides : {}", e.to_string().chars().take(160).collect::<String>()))
}

fn clean_text(s: &str) -> Result<&str, String> {
    let t = s.trim();
    if t.chars().count() < 2 || t.chars().count() > 80 || t.chars().any(|c| c.is_control()) {
        return Err("texte de recherche invalide (2 à 80 caractères)".into());
    }
    Ok(t)
}

fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' || !b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit()) {
        return false;
    }
    let (y, m, d): (u32, u32, u32) = (s[..4].parse().unwrap_or(0), s[5..7].parse().unwrap_or(0), s[8..].parse().unwrap_or(0));
    y >= 2000 && (1..=12).contains(&m) && (1..=31).contains(&d)
}

/// GraphQL string literal. JSON escaping is a valid subset of GraphQL string escaping.
fn gql_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

// ---- the client ----------------------------------------------------------------------------------------

pub struct Crm {
    base: Url,
    token: String,
    http: Client,
    /// The user's task explicitly asked for phone/email: do not mask them in tool results.
    reveal_pii: bool,
}

impl Crm {
    /// `base` must come from the configured workspace (validated by `parse_origin`: https, bare origin).
    pub fn new(base: Url, token: String, timeout: Duration, reveal_pii: bool) -> Result<Self, String> {
        let http = Client::builder()
            .timeout(timeout)
            .redirect(Policy::none()) // the credential never follows a redirect elsewhere
            .build()
            .map_err(|_| "client HTTP indisponible".to_string())?;
        Ok(Self { base, token, http, reveal_pii })
    }

    pub fn reveal(&self) -> bool {
        self.reveal_pii
    }

    pub fn secrets(&self) -> Vec<String> {
        vec![self.token.clone()]
    }

    /// The single place that decides how the credential is presented. Adjust here if Twenty needs more.
    fn headers(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let origin = self.base.origin().ascii_serialization();
        req.header("Authorization", format!("Bearer {}", self.token))
            .header("Origin", origin)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
    }

    async fn gql(&self, query: &str) -> Result<Value, String> {
        let url = self.base.join("graphql").map_err(|_| "URL invalide".to_string())?;
        // Defence in depth: same scheme/host/port as the configured workspace.
        if url.host_str() != self.base.host_str() || url.port() != self.base.port() || url.scheme() != self.base.scheme() {
            return Err("origine non autorisée".into());
        }
        let mut resp = self
            .headers(self.http.post(url))
            .body(json!({ "query": query }).to_string())
            .send()
            .await
            .map_err(|e| if e.is_timeout() { "le CRM n'a pas répondu à temps".to_string() } else { "CRM injoignable".to_string() })?;
        let status = resp.status();
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|_| "lecture interrompue".to_string())? {
            body.extend_from_slice(&chunk);
            if body.len() > MAX_RESPONSE_BYTES {
                return Err("réponse du CRM trop volumineuse".into());
            }
        }
        let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err("session CRM expirée ou accès refusé : reconnectez-vous dans la fenêtre CRM".into());
        }
        if let Some(msg) = v.pointer("/errors/0/message").and_then(|m| m.as_str()) {
            return Err(format!("le CRM a refusé la lecture : {}", scrub_secrets(msg, &self.secrets()).chars().take(200).collect::<String>()));
        }
        if !status.is_success() {
            return Err(format!("erreur CRM (HTTP {})", status.as_u16()));
        }
        v.get("data").cloned().ok_or_else(|| "réponse CRM inattendue".to_string())
    }

    /// One connection query. Returns (total, rows-after-masking).
    async fn fetch(&self, obj: &Obj, first: usize, filter: Option<String>, fields: &[&str]) -> Result<(u64, Vec<Value>), String> {
        let args = match filter {
            Some(f) => format!("first: {first}, filter: {f}"),
            None => format!("first: {first}"),
        };
        let q = format!("{{ {}({}) {{ totalCount edges {{ node {{ {} }} }} }} }}", obj.plural, args, fields.join(" "));
        let data = self.gql(&q).await?;
        let conn = data.get(obj.plural).ok_or("réponse CRM inattendue")?;
        let total = conn.get("totalCount").and_then(|t| t.as_u64()).unwrap_or(0);
        let rows = conn
            .get("edges")
            .and_then(|e| e.as_array())
            .ok_or("réponse CRM inattendue")?
            .iter()
            .filter_map(|e| e.get("node"))
            .map(|n| self.mask_row(n))
            .collect();
        Ok((total, rows))
    }

    fn mask_row(&self, node: &Value) -> Value {
        let Some(m) = node.as_object() else { return Value::Null };
        let mut out = serde_json::Map::new();
        for (k, v) in m {
            let nv = match v {
                Value::String(s) if k == "email" && !self.reveal_pii => Value::String(mask_email(s)),
                Value::String(s) if is_phone_field(k) && !self.reveal_pii => Value::String(mask_phone(s)),
                Value::String(s) if self.reveal_pii => Value::String(s.chars().take(MAX_TEXT_CHARS).collect()),
                Value::String(s) => Value::String(mask_text(&s.chars().take(MAX_TEXT_CHARS).collect::<String>())),
                other => other.clone(),
            };
            out.insert(k.clone(), nv);
        }
        Value::Object(out)
    }

    /// Dispatch by tool name. The caller has already checked the name against `TOOL_NAMES`.
    pub async fn call(&self, tool: &str, args: &Value) -> Result<Value, String> {
        // Models sometimes send an empty string for "no arguments".
        let args = if args.is_null() || args.as_str() == Some("") { json!({}) } else { args.clone() };
        match tool {
            "count_records" => {
                let a: CountArgs = parse(&args)?;
                let o = object(&a.object)?;
                let (total, _) = self.fetch(o, 1, None, &["id"]).await?;
                Ok(json!({ "object": o.plural, "count": total }))
            }
            "list_records" => {
                let a: ListArgs = parse(&args)?;
                let o = object(&a.object)?;
                let limit = a.limit.unwrap_or(10);
                if !(1..=20).contains(&limit) {
                    return Err("limit doit être entre 1 et 20".into());
                }
                if a.fields.len() > 10 {
                    return Err("10 champs au maximum".into());
                }
                let mut sel: Vec<&str> = vec![];
                for f in &a.fields {
                    let known = o.fields.iter().find(|k| **k == f.as_str()).ok_or_else(|| {
                        format!("champ non autorisé pour {} : {} (autorisés : {})", o.plural, f.chars().take(30).collect::<String>(), o.fields.join(", "))
                    })?;
                    if !sel.contains(known) {
                        sel.push(known);
                    }
                }
                if sel.is_empty() {
                    sel = o.default.to_vec();
                }
                let (total, rows) = self.fetch(o, limit as usize, None, &sel).await?;
                Ok(cap(json!({ "object": o.plural, "total": total }), rows))
            }
            "find_client" => {
                let a: FindArgs = parse(&args)?;
                let o = object("agencyClients")?;
                let filter = match (a.reference.as_deref(), a.name.as_deref()) {
                    (Some(r), None) => format!("{{ externalId: {{ eq: {} }} }}", gql_str(clean_text(r)?)),
                    (None, Some(n)) => format!("{{ name: {{ ilike: {} }} }}", gql_str(&format!("%{}%", clean_text(n)?))),
                    _ => return Err("fournir exactement un des champs : reference ou name".into()),
                };
                let (total, rows) = self.fetch(o, 5, Some(filter), &["id", "name", "phone", "email", "temperature", "source", "externalId"]).await?;
                Ok(cap(json!({ "object": o.plural, "total": total }), rows))
            }
            "list_visits" => {
                let a: VisitArgs = parse(&args)?;
                if !valid_date(&a.from) || !valid_date(&a.to) || a.from > a.to {
                    return Err("dates invalides : format AAAA-MM-JJ, from <= to".into());
                }
                let mut conds = vec![
                    format!("{{ scheduledAt: {{ gte: {} }} }}", gql_str(&format!("{}T00:00:00.000Z", a.from))),
                    format!("{{ scheduledAt: {{ lte: {} }} }}", gql_str(&format!("{}T23:59:59.999Z", a.to))),
                ];
                if let Some(s) = a.status.as_deref() {
                    let s = VISIT_STATUSES.iter().find(|v| **v == s).ok_or("statut invalide")?;
                    conds.push(format!("{{ status: {{ eq: {s} }} }}")); // enum literal from the allowlist
                }
                let o = object("agencyVisits")?;
                let (total, rows) = self.fetch(o, 30, Some(format!("{{ and: [{}] }}", conds.join(", "))), o.default).await?;
                Ok(cap(json!({ "object": o.plural, "total": total }), rows))
            }
            "list_conversations_needing_reply" => {
                let _: NoArgs = parse(&args)?;
                let o = object("whatsAppConversations")?;
                let f = Some("{ status: { eq: WAITING_STAFF } }".to_string());
                let (total, mut rows) = self.fetch(o, 50, f, &["id", "threadId", "status", "direction", "lastMessage", "lastMessageAt"]).await?;
                // oldest waiting first (sorted here, not in the query, to avoid depending on orderBy enum names)
                rows.sort_by(|a, b| a["lastMessageAt"].as_str().cmp(&b["lastMessageAt"].as_str()));
                Ok(cap(json!({ "object": o.plural, "total": total }), rows))
            }
            _ => Err("outil inconnu".into()),
        }
    }
}

/// Row cap by bytes: drop trailing rows until the result fits.
fn cap(mut head: Value, mut rows: Vec<Value>) -> Value {
    let total = rows.len();
    while serde_json::to_string(&rows).map(|s| s.len()).unwrap_or(0) > MAX_RESULT_BYTES && !rows.is_empty() {
        rows.pop();
    }
    head["returned"] = json!(rows.len());
    head["truncated"] = json!(rows.len() < total);
    head["rows"] = Value::Array(rows);
    head
}

/// Heuristic: did the user's task explicitly ask for a phone number or an email?
pub fn task_needs_pii(task: &str) -> bool {
    let t = task.to_lowercase();
    ["numéro", "numero", "téléphone", "telephone", "tél", "phone", "portable", "e-mail", "email", "mail", "contact de"].iter().any(|w| t.contains(w))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ck(v: &str) -> Vec<(String, String)> {
        vec![("other".into(), "x".into()), ("tokenPair".into(), v.into())]
    }

    #[test]
    fn token_from_cookie() {
        let raw = r#"{"accessOrWorkspaceAgnosticToken":{"token":"abc.def-ghi","expiresAt":"x"},"refreshToken":{"token":"R"}}"#;
        assert_eq!(extract_token(&ck(raw)).as_deref(), Some("abc.def-ghi"));
        // url-encoded form, as cookies usually store it
        let enc = raw.replace('{', "%7B").replace('}', "%7D").replace('"', "%22").replace(':', "%3A").replace(',', "%2C");
        assert_eq!(extract_token(&ck(&enc)).as_deref(), Some("abc.def-ghi"));
        assert_eq!(extract_token(&ck(r#"{"accessToken":{"token":"zzz"}}"#)).as_deref(), Some("zzz"));
        for bad in ["", "not json", "{}", r#"{"accessOrWorkspaceAgnosticToken":{"token":""}}"#,
            r#"{"accessOrWorkspaceAgnosticToken":{"token":"a b"}}"#, r#"{"accessOrWorkspaceAgnosticToken":{"token":"a\r\nX: y"}}"#,
            r#"{"accessOrWorkspaceAgnosticToken":{"token":5}}"#] {
            assert!(extract_token(&ck(bad)).is_none(), "{bad}");
        }
        assert!(extract_token(&[]).is_none());
        assert!(extract_token(&[("session".into(), raw.into())]).is_none());
        assert_eq!(percent_decode("%7"), "%7");
        assert_eq!(percent_decode("a%2"), "a%2");
    }

    #[test]
    fn tool_specs_are_the_fixed_five() {
        let names: Vec<String> = tool_specs().as_array().unwrap().iter().map(|t| t["function"]["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, TOOL_NAMES);
    }

    #[test]
    fn helpers() {
        assert!(valid_date("2026-10-06") && !valid_date("2026-13-01") && !valid_date("2026-10-6") && !valid_date("2026-10-06T00") && !valid_date("1999-01-01"));
        assert_eq!(gql_str("a\"b\\c\n} }"), r#""a\"b\\c\n} }""#);
        assert!(task_needs_pii("donne-moi le numéro de Karim") && !task_needs_pii("combien de visites demain"));
        assert!(object("users").is_err() && object("agencyClients").is_ok());
        assert!(clean_text(" a ").is_err() && clean_text("Karim").is_ok() && clean_text("a\nb c").is_err());
    }
}

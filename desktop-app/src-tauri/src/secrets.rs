//! OpenRouter key in the OS credential store (`keyring`), plus the non-secret model setting on disk.
use serde_json::json;
use std::{fs, path::Path};

pub const DEFAULT_MODEL: &str = "meta-llama/llama-3.3-70b-instruct:free";
/// Suggestions for the UI only. UNVERIFIED: slugs on OpenRouter's free tier change; any `:free` slug is accepted.
pub const MODEL_OPTIONS: &[&str] = &[
    DEFAULT_MODEL,
    "qwen/qwen3-coder:free",
    "google/gemma-3-27b-it:free",
    "mistralai/mistral-small-3.2-24b-instruct:free",
    "deepseek/deepseek-chat-v3-0324:free",
];

/// FREE models only: `vendor/name:free`, conservative charset, bounded length.
pub fn validate_model(s: &str) -> Result<(), String> {
    let ok_chars = |p: &str| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    let valid = s.len() <= 100
        && s.strip_suffix(":free")
            .and_then(|b| b.split_once('/'))
            .map(|(a, b)| ok_chars(a) && ok_chars(b))
            .unwrap_or(false);
    if valid { Ok(()) } else { Err("Seuls les modèles gratuits (identifiant se terminant par :free) sont autorisés.".into()) }
}

pub fn validate_key(k: &str) -> Result<(), String> {
    if (16..=256).contains(&k.len()) && k.chars().all(|c| c.is_ascii_graphic()) {
        Ok(())
    } else {
        Err("Clé invalide.".into())
    }
}

pub trait KeyStore: Send + Sync {
    fn get(&self) -> Option<String>;
    fn set(&self, key: &str) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
}

/// Windows Credential Manager / macOS Keychain / Secret Service. Errors are generic on purpose.
pub struct OsKeyStore;

impl OsKeyStore {
    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new("com.annonces360.crm", "openrouter-api-key").map_err(|_| "Coffre de secrets indisponible.".to_string())
    }
}

impl KeyStore for OsKeyStore {
    fn get(&self) -> Option<String> {
        Self::entry().ok()?.get_password().ok().filter(|k| !k.is_empty())
    }
    fn set(&self, key: &str) -> Result<(), String> {
        Self::entry()?.set_password(key).map_err(|_| "Impossible d'enregistrer la clé dans le coffre du système.".to_string())
    }
    fn clear(&self) -> Result<(), String> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Impossible de supprimer la clé.".into()),
        }
    }
}

pub fn load_model(dir: &Path) -> String {
    fs::read_to_string(dir.join("agent-settings.json"))
        .ok()
        .and_then(|r| serde_json::from_str::<serde_json::Value>(&r).ok())
        .and_then(|v| v.get("model").and_then(|m| m.as_str()).map(String::from))
        .filter(|m| validate_model(m).is_ok())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string())
}

pub fn save_model(dir: &Path, model: &str) -> Result<(), String> {
    validate_model(model)?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("agent-settings.json"), json!({ "model": model }).to_string()).map_err(|e| e.to_string())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct MemStore(pub Mutex<Option<String>>);
    impl KeyStore for MemStore {
        fn get(&self) -> Option<String> {
            self.0.lock().unwrap().clone()
        }
        fn set(&self, k: &str) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(k.into());
            Ok(())
        }
        fn clear(&self) -> Result<(), String> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }
    }

    #[test]
    fn only_free_models() {
        for m in MODEL_OPTIONS {
            assert!(validate_model(m).is_ok(), "{m}");
        }
        for bad in [
            "openai/gpt-4o", "openai/gpt-4o:free:paid", "anthropic/claude-3.5-sonnet", "meta/llama:free2", ":free", "a/:free",
            "/b:free", "a/b/c:free", "a/b:FREE", "a b/c:free", "openai/gpt-4o?x=:free", "a/b:free\n", "", "openrouter/auto",
            "a/b:free,openai/gpt-4o", &format!("a/{}:free", "x".repeat(100)),
        ] {
            assert!(validate_model(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn key_and_settings_roundtrip() {
        assert!(validate_key("sk-or-v1-0123456789abcdef").is_ok());
        assert!(validate_key("short").is_err() && validate_key("has space in it 0123456789").is_err());
        let s = MemStore::default();
        assert!(s.get().is_none());
        s.set("k").unwrap();
        assert!(s.get().is_some());
        s.clear().unwrap();
        assert!(s.get().is_none());
        let dir = std::env::temp_dir().join(format!("crm360-set-{}", crate::trace::now_ms()));
        assert_eq!(load_model(&dir), DEFAULT_MODEL);
        assert!(save_model(&dir, "openai/gpt-4o").is_err());
        save_model(&dir, "qwen/qwen3-coder:free").unwrap();
        assert_eq!(load_model(&dir), "qwen/qwen3-coder:free");
        // a tampered settings file falls back to the default
        fs::write(dir.join("agent-settings.json"), r#"{"model":"openai/gpt-4o"}"#).unwrap();
        assert_eq!(load_model(&dir), DEFAULT_MODEL);
        let _ = fs::remove_dir_all(dir);
    }
}

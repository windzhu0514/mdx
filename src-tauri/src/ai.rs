use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::Mutex;
use tokio::sync::oneshot;
use url::{Host, Url};

const AI_KEYRING_SERVICE: &str = "com.mora.mojian";
const AI_KEYRING_USER: &str = "openai-compatible-api-key";

#[derive(Default)]
pub(crate) struct AiRequestState {
    pub(crate) cancel: Mutex<Option<oneshot::Sender<()>>>,
}

fn ai_key_entry() -> Result<keyring::v1::Entry, String> {
    keyring::v1::Entry::new(AI_KEYRING_SERVICE, AI_KEYRING_USER)
        .map_err(|_| "无法访问系统凭据库".to_string())
}

fn credential_presence(result: keyring::v1::Result<String>) -> Result<bool, String> {
    match result {
        Ok(_) => Ok(true),
        Err(keyring::v1::Error::NoEntry) => Ok(false),
        Err(_) => Err("无法检查 AI API Key 配置".to_string()),
    }
}

fn credential_delete_result(result: keyring::v1::Result<()>) -> Result<(), String> {
    match result {
        Ok(()) | Err(keyring::v1::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法删除 AI API Key".to_string()),
    }
}

#[tauri::command]
pub(crate) fn save_ai_api_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("AI API Key 不能为空".to_string());
    }

    ai_key_entry()?
        .set_password(key)
        .map_err(|_| "无法保存 AI API Key".to_string())
}

#[tauri::command]
pub(crate) fn has_ai_api_key() -> Result<bool, String> {
    credential_presence(ai_key_entry()?.get_password())
}

#[tauri::command]
pub(crate) fn delete_ai_api_key() -> Result<(), String> {
    credential_delete_result(ai_key_entry()?.delete_credential())
}

pub fn validate_base_url(value: &str) -> Result<Url, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("AI Base URL 不能为空".to_string());
    }

    let mut url = Url::parse(value).map_err(|_| "AI Base URL 格式无效".to_string())?;
    let host = url
        .host()
        .ok_or_else(|| "AI Base URL 必须包含主机".to_string())?;

    match url.scheme() {
        "https" => {}
        "http"
            if matches!(
                host,
                Host::Domain("localhost")
                    | Host::Ipv4(Ipv4Addr::LOCALHOST)
                    | Host::Ipv6(Ipv6Addr::LOCALHOST)
            ) => {}
        "http" => return Err("远程 AI Base URL 必须使用 HTTPS".to_string()),
        _ => return Err("AI Base URL 仅支持 HTTP 或 HTTPS".to_string()),
    }

    url.set_query(None);
    url.set_fragment(None);
    let path = url.path().trim_end_matches('/');
    url.set_path(&format!("{path}/chat/completions"));
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_and_local_http() {
        assert!(validate_base_url("https://api.openai.com/v1").is_ok());
        assert!(validate_base_url("http://localhost:11434/v1").is_ok());
        assert!(validate_base_url("http://127.0.0.1:1234/v1").is_ok());
        assert!(validate_base_url("http://[::1]:1234/v1").is_ok());
    }

    #[test]
    fn rejects_empty_host_remote_http_and_non_http_schemes() {
        assert!(validate_base_url("   ").is_err());
        assert!(validate_base_url("https://").is_err());
        assert!(validate_base_url("http://example.com/v1").is_err());
        assert!(validate_base_url("file:///tmp/api").is_err());
    }

    #[test]
    fn normalizes_chat_completions_path_and_removes_query_and_fragment() {
        let url =
            validate_base_url(" https://api.openai.com/v1/?organization=secret#fragment ").unwrap();

        assert_eq!(url.as_str(), "https://api.openai.com/v1/chat/completions");
        assert_eq!(url.query(), None);
        assert_eq!(url.fragment(), None);
    }

    #[test]
    fn no_entry_is_the_only_missing_credential_result() {
        assert_eq!(
            credential_presence(Err(keyring::v1::Error::NoEntry)),
            Ok(false)
        );
        assert_eq!(
            credential_presence(Ok("stored-secret".to_string())),
            Ok(true)
        );
        assert!(credential_presence(Err(keyring::v1::Error::BadEncoding(vec![1]))).is_err());
    }

    #[test]
    fn deleting_an_absent_credential_succeeds() {
        assert_eq!(
            credential_delete_result(Err(keyring::v1::Error::NoEntry)),
            Ok(())
        );
        assert_eq!(credential_delete_result(Ok(())), Ok(()));
    }

    #[test]
    fn credential_errors_do_not_expose_secret_material() {
        let secret = "sk-do-not-leak";
        let error = credential_presence(Err(keyring::v1::Error::BadEncoding(
            secret.as_bytes().to_vec(),
        )))
        .unwrap_err();

        assert!(!error.contains(secret));
    }

    #[test]
    fn saving_an_empty_key_is_rejected_before_accessing_the_keyring() {
        assert_eq!(
            save_ai_api_key("  \n ".to_string()),
            Err("AI API Key 不能为空".to_string())
        );
    }

    #[test]
    fn request_state_starts_without_a_cancellation_sender() {
        let state = AiRequestState::default();

        assert!(state.cancel.lock().unwrap().is_none());
    }
}

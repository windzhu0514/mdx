use std::collections::HashSet;
use std::sync::OnceLock;

pub fn normalize_font_family_names(families: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for family in families {
        let family = family.trim();
        let key = family.to_lowercase();
        if family.is_empty() || !seen.insert(key) {
            continue;
        }
        normalized.push(family.to_string());
    }

    normalized.sort_by_key(|family| family.to_lowercase());
    normalized
}

#[tauri::command]
pub fn list_system_font_families() -> Vec<String> {
    static SYSTEM_FONT_FAMILIES: OnceLock<Vec<String>> = OnceLock::new();

    SYSTEM_FONT_FAMILIES
        .get_or_init(|| {
            let mut database = fontdb::Database::new();
            database.load_system_fonts();
            normalize_font_family_names(
                database
                    .faces()
                    .flat_map(|face| face.families.iter().map(|(family, _)| family.clone())),
            )
        })
        .clone()
}

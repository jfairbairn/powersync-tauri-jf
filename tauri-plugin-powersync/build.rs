const COMMANDS: &[&str] = &[
    "open",
    "close",
    "execute",
    "execute_batch",
    "get_all",
    "get_optional",
    "begin_transaction",
    "commit_transaction",
    "rollback_transaction",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}

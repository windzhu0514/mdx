#[tokio::main]
async fn main() {
    let code = mdxnote_lib::agent_cli::main_entry(std::env::args_os()).await;
    std::process::exit(code);
}

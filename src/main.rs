use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    info!("relay listening on 0.0.0.0:3000 (stub)");
    Ok(())
}

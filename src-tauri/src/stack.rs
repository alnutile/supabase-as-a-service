//! The local Supabase stack behind the desktop app.
//!
//! Everything the hosted deploy gets from CI happens here at launch instead:
//! check Docker + the Supabase CLI, copy the bundled `supabase/` project into the
//! app-data dir, `supabase start`, apply new migrations, point the pg_cron jobs at
//! the local functions, and run `supabase functions serve` with the user's secrets.
//! Progress streams to the launcher as `stack-step` / `stack-log` events.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Docker project name for the desktop stack — distinct from the repo's own
/// `intranet` project_id so it never collides with a developer's `supabase start`.
const PROJECT_ID: &str = "supanet-desktop";

/// How long to wait for `functions serve` to report it is serving before opening anyway.
const FUNCTIONS_READY_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Default)]
pub struct StackState {
    functions: Mutex<Option<Child>>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub openrouter_api_key: String,
    pub openrouter_model: String,
    pub stop_on_quit: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            openrouter_api_key: String::new(),
            openrouter_model: String::new(),
            stop_on_quit: true,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prereqs {
    docker_installed: bool,
    docker_running: bool,
    docker_detail: String,
    supabase_installed: bool,
    supabase_ok: bool,
    supabase_detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackInfo {
    api_url: String,
    anon_key: String,
    studio_url: Option<String>,
    mail_url: Option<String>,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Last few lines of command output — enough to explain a failure without a wall of text.
fn tail(text: &str) -> String {
    let lines: Vec<&str> = text.trim().lines().collect();
    lines[lines.len().saturating_sub(8)..].join("\n")
}

/// Apps launched from Finder/Dock get a bare PATH (/usr/bin:/bin:…), so `docker` and
/// `supabase` wouldn't resolve. Add the places Docker Desktop and Homebrew install to.
pub fn extend_path() {
    if !cfg!(unix) {
        return;
    }
    let mut extra = vec![
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/Applications/Docker.app/Contents/Resources/bin".to_string(),
    ];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        extra.push(home.join(".docker/bin").display().to_string());
        extra.push(home.join(".local/bin").display().to_string());
    }
    let current = std::env::var("PATH").unwrap_or_default();
    let mut parts: Vec<String> = current
        .split(':')
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect();
    for dir in extra {
        if !parts.contains(&dir) {
            parts.push(dir);
        }
    }
    std::env::set_var("PATH", parts.join(":"));
}

/// Runs a command to completion. `Err` means it couldn't be spawned (not installed);
/// `Ok((success, output))` otherwise, with stderr preferred on failure.
fn probe(program: &str, args: &[&str]) -> std::io::Result<(bool, String)> {
    let out = Command::new(program).args(args).output()?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let text = if out.status.success() || stderr.is_empty() { stdout } else { stderr };
    Ok((out.status.success(), text))
}

#[tauri::command]
pub async fn check_prereqs() -> Result<Prereqs, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let docker_installed = matches!(probe("docker", &["--version"]), Ok((true, _)));
        let (docker_running, docker_detail) = if docker_installed {
            match probe("docker", &["info", "--format", "{{.ServerVersion}}"]) {
                Ok((true, version)) => (true, format!("Docker engine {version}")),
                Ok((false, out)) => (false, tail(&out)),
                Err(e) => (false, e.to_string()),
            }
        } else {
            (false, "Docker was not found on this machine.".to_string())
        };
        let (supabase_installed, supabase_ok, supabase_detail) =
            match probe("supabase", &["--version"]) {
                Ok((true, version)) => (true, true, format!("Supabase CLI {version}")),
                Ok((false, out)) => (true, false, tail(&out)),
                Err(_) => (false, false, "The Supabase CLI was not found on this machine.".to_string()),
            };
        Prereqs {
            docker_installed,
            docker_running,
            docker_detail,
            supabase_installed,
            supabase_ok,
            supabase_detail,
        }
    })
    .await
    .map_err(err)
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(err)?.join("settings.json"))
}

fn read_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// `None` on first run (no settings saved yet) — the launcher waits for the user then.
#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<Option<Settings>, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(read_settings(&app)))
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(&app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    fs::write(&path, serde_json::to_string_pretty(&settings).map_err(err)?).map_err(err)
}

fn stack_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(err)?.join("stack"))
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Host ports for the desktop stack: the CLI defaults (543xx) shifted to 554xx, so it can
/// run alongside a developer's own `supabase start` of this repo. A section the repo's
/// config.toml already defines is left as-is (TOML forbids redefining a table).
const DESKTOP_PORTS: &[(&str, &str)] = &[
    ("[api]", "port = 55421"),
    ("[db]", "port = 55422\nshadow_port = 55420"),
    ("[db.pooler]", "port = 55429"),
    ("[studio]", "port = 55423"),
    ("[inbucket]", "port = 55424"),
    ("[analytics]", "port = 55427"),
];

/// The repo's config.toml with the desktop project_id and ports.
fn desktop_config(config: &str) -> String {
    let id_line = format!("project_id = \"{PROJECT_ID}\"");
    let mut out = if config.lines().any(|l| l.trim_start().starts_with("project_id")) {
        config
            .lines()
            .map(|l| if l.trim_start().starts_with("project_id") { id_line.as_str() } else { l })
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        format!("{id_line}\n{config}")
    };
    for (table, body) in DESKTOP_PORTS {
        if !config.lines().any(|l| l.trim() == *table) {
            out.push_str(&format!("\n\n{table}\n{body}"));
        }
    }
    out.push('\n');
    out
}

/// Runs before the repo's 0001. Newer Supabase Postgres images (17.6.1.15x+) stopped
/// granting new `public` tables to the API roles by default; the migrations were written
/// against the old default (RLS is the boundary, explicit revokes where needed), so on a
/// new image every table 403s. Restoring the old default up front keeps every migration —
/// including its deliberate revokes — behaving exactly as it does on existing projects.
const DEFAULT_GRANTS_MIGRATION: (&str, &str) = (
    "0000_desktop_default_privileges.sql",
    "alter default privileges for role postgres in schema public\n  \
       grant all on tables to anon, authenticated, service_role;\n\
     alter default privileges for role postgres in schema public\n  \
       grant all on sequences to anon, authenticated, service_role;\n\
     alter default privileges for role postgres in schema public\n  \
       grant all on functions to anon, authenticated, service_role;\n",
);

/// Lays out `<app-data>/stack/supabase` from the bundled project. Migrations and
/// functions are refreshed every launch so an app update ships its schema and function
/// changes; the CLI's own state (`.temp`, `.branches`) and the database volume are kept.
fn prepare_workdir(app: &AppHandle, settings: &Settings) -> Result<PathBuf, String> {
    let bundled = app.path().resource_dir().map_err(err)?.join("stack/supabase");
    let root = stack_root(app)?;
    let project = root.join("supabase");
    fs::create_dir_all(&project).map_err(err)?;
    for dir in ["migrations", "functions"] {
        let dst = project.join(dir);
        if dst.exists() {
            fs::remove_dir_all(&dst).map_err(err)?;
        }
        copy_dir(&bundled.join(dir), &dst).map_err(|e| format!("copying bundled {dir}: {e}"))?;
    }
    fs::write(project.join("migrations").join(DEFAULT_GRANTS_MIGRATION.0), DEFAULT_GRANTS_MIGRATION.1)
        .map_err(err)?;
    let config = fs::read_to_string(bundled.join("config.toml")).map_err(err)?;
    fs::write(project.join("config.toml"), desktop_config(&config)).map_err(err)?;

    // Edge-function secrets (what `supabase secrets set` does for a hosted project).
    // Kept outside functions/ so the refresh above never wipes it. The launcher owns
    // only the OpenRouter keys; any other line a user added by hand is preserved.
    let env_path = root.join("functions.env");
    let managed = ["OPENROUTER_API_KEY=", "OPENROUTER_MODEL="];
    let mut env: String = fs::read_to_string(&env_path)
        .unwrap_or_default()
        .lines()
        .filter(|l| !managed.iter().any(|m| l.trim_start().starts_with(m)))
        .map(|l| format!("{l}\n"))
        .collect();
    if !settings.openrouter_api_key.trim().is_empty() {
        env.push_str(&format!("OPENROUTER_API_KEY={}\n", settings.openrouter_api_key.trim()));
    }
    if !settings.openrouter_model.trim().is_empty() {
        env.push_str(&format!("OPENROUTER_MODEL={}\n", settings.openrouter_model.trim()));
    }
    fs::write(&env_path, env).map_err(err)?;
    Ok(root)
}

/// Drops terminal color codes (`ESC[31m` …) — the CLI colors its errors, and the
/// launcher shows plain text.
fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.next() == Some('[') {
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

// Progress also goes to stderr, so a boot can be followed (or debugged) from a terminal.
fn emit_step(app: &AppHandle, step: &str) {
    eprintln!("[stack-step] {step}");
    let _ = app.emit("stack-step", step);
}

fn emit_log(app: &AppHandle, event: &str, line: &str) {
    let line = strip_ansi(line);
    eprintln!("[{event}] {line}");
    let _ = app.emit(event, &line);
}

/// Runs `supabase <args>` in the stack dir, streaming every output line to the launcher.
fn run_streaming(app: &AppHandle, cwd: &Path, args: &[&str]) -> Result<(), String> {
    let label = format!("supabase {}", args.join(" "));
    emit_log(app, "stack-log", &format!("$ {label}"));
    let mut child = Command::new("supabase")
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't run `{label}`: {e}"))?;

    let stderr = child.stderr.take().expect("stderr is piped");
    let err_app = app.clone();
    let err_reader = std::thread::spawn(move || {
        let mut lines = Vec::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let line = strip_ansi(&line);
            emit_log(&err_app, "stack-log", &line);
            lines.push(line);
        }
        lines
    });
    for line in BufReader::new(child.stdout.take().expect("stdout is piped"))
        .lines()
        .map_while(Result::ok)
    {
        emit_log(app, "stack-log", &line);
    }
    let err_lines = err_reader.join().unwrap_or_default();
    let status = child.wait().map_err(err)?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("`{label}` failed:\n{}", tail(&err_lines.join("\n"))))
    }
}

fn read_status(root: &Path) -> Result<StackInfo, String> {
    let out = Command::new("supabase")
        .args(["status", "-o", "json"])
        .current_dir(root)
        .output()
        .map_err(err)?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    // Some CLI versions print a notice before the JSON; parse from the first brace.
    let json = stdout.find('{').map(|i| &stdout[i..]).unwrap_or("");
    let status: serde_json::Value = serde_json::from_str(json).map_err(|e| {
        format!(
            "couldn't read `supabase status`: {e}\n{}",
            tail(&String::from_utf8_lossy(&out.stderr))
        )
    })?;
    let field = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| status.get(*k).and_then(|v| v.as_str()))
            .map(String::from)
    };
    Ok(StackInfo {
        api_url: field(&["API_URL"]).ok_or("`supabase status` has no API_URL")?,
        // The legacy JWT anon key works with every supabase-js version the app uses.
        anon_key: field(&["ANON_KEY", "PUBLISHABLE_KEY"]).ok_or("`supabase status` has no ANON_KEY")?,
        studio_url: field(&["STUDIO_URL"]),
        mail_url: field(&["MAILPIT_URL", "INBUCKET_URL"]),
    })
}

/// Points the scheduler / event-dispatch pg_cron jobs at the local functions (migration
/// 0094). Hosted tenants get this from the deploy pipeline. pg_net runs inside the db
/// container, so it reaches the API gateway by its container name, not 127.0.0.1.
/// Best-effort: a failure only means scheduled agents won't fire, so it's logged.
fn wire_cron(app: &AppHandle) {
    let sql = format!("select public.setup_automation_cron('http://supabase_kong_{PROJECT_ID}:8000');");
    let db = format!("supabase_db_{PROJECT_ID}");
    match probe("docker", &["exec", &db, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", &sql]) {
        Ok((true, _)) => emit_log(app, "stack-log", "Scheduled jobs pointed at the local functions."),
        Ok((false, out)) => emit_log(app, "stack-log", &format!("warning: couldn't set up scheduled jobs: {}", tail(&out))),
        Err(e) => emit_log(app, "stack-log", &format!("warning: couldn't set up scheduled jobs: {e}")),
    }
}

/// Asks a child to exit (SIGTERM, so the CLI tears down its edge-runtime container),
/// then kills it if it hasn't within a few seconds. On unix the child leads its own
/// process group (see `start_functions`) and the whole group is signalled: Homebrew's
/// `supabase` is a Node wrapper around the real binary, so signalling only the wrapper
/// would orphan the server.
fn terminate(child: &mut Child) {
    if cfg!(unix) {
        let group = format!("-{}", child.id());
        let _ = Command::new("kill").args(["-TERM", "--", &group]).status();
        for _ in 0..50 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                // The wrapper exiting first doesn't mean its child has.
                let _ = Command::new("kill").args(["-KILL", "--", &group]).status();
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = Command::new("kill").args(["-KILL", "--", &group]).status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Starts `supabase functions serve` and waits until it reports serving. The CLI's
/// banner has gone to stdout or stderr depending on version, so both are watched.
fn start_functions(app: &AppHandle, root: &Path) -> Result<(), String> {
    let state = app.state::<StackState>();
    let mut slot = state.functions.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(mut old) = slot.take() {
        terminate(&mut old);
    }
    let env_file = root.join("functions.env");
    let mut command = Command::new("supabase");
    command
        .args(["functions", "serve", "--env-file"])
        .arg(&env_file)
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("couldn't run `supabase functions serve`: {e}"))?;

    let (ready_tx, ready_rx) = mpsc::channel::<()>();
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    for stream in [Box::new(stdout) as Box<dyn std::io::Read + Send>, Box::new(stderr)] {
        let app = app.clone();
        let ready = ready_tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                if line.contains("Serving functions") {
                    let _ = ready.send(());
                }
                emit_log(&app, "functions-log", &line);
            }
        });
    }
    drop(ready_tx);
    *slot = Some(child);
    drop(slot);

    match ready_rx.recv_timeout(FUNCTIONS_READY_TIMEOUT) {
        Ok(()) => Ok(()),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            emit_log(app, "stack-log", "warning: edge functions are still starting; opening anyway.");
            Ok(())
        }
        // Both streams closed without the banner: the server exited.
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("`supabase functions serve` exited during startup — see the log above.".to_string())
        }
    }
}

/// The gateway routes the app talks to. Each must answer 2xx before the workspace opens.
const SERVICE_CHECKS: &[(&str, &str)] = &[
    ("database API", "/rest/v1/"),
    ("auth", "/auth/v1/health"),
    ("storage", "/storage/v1/version"),
];

/// How long a first boot on a busy machine may take for the services to come up.
const SERVICES_READY_TIMEOUT: Duration = Duration::from_secs(300);

/// Polls each service through the API gateway (with the anon key, like the app) until
/// it answers. Uses the system `curl` so the app needs no HTTP client of its own.
fn wait_for_services(app: &AppHandle, info: &StackInfo) -> Result<(), String> {
    let deadline = std::time::Instant::now() + SERVICES_READY_TIMEOUT;
    let apikey = format!("apikey: {}", info.anon_key);
    for (name, path) in SERVICE_CHECKS {
        let url = format!("{}{path}", info.api_url.trim_end_matches('/'));
        emit_log(app, "stack-log", &format!("Waiting for {name}…"));
        loop {
            if matches!(probe("curl", &["-sf", "-m", "5", "-H", &apikey, &url]), Ok((true, _))) {
                emit_log(app, "stack-log", &format!("{name} is up."));
                break;
            }
            if std::time::Instant::now() >= deadline {
                return Err(format!(
                    "{name} didn't come up within {} minutes. Docker may be short on memory — \
                     try closing other containers, then start again.",
                    SERVICES_READY_TIMEOUT.as_secs() / 60
                ));
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    }
    Ok(())
}

fn start_stack_blocking(app: &AppHandle) -> Result<StackInfo, String> {
    let settings = read_settings(app);
    emit_step(app, "prepare");
    let root = prepare_workdir(app, &settings)?;
    emit_step(app, "start");
    // The CLI gives up (and tears everything down) if any container misses its health
    // deadline — routine on a first run or a busy Docker host. So skip the logging
    // services the app doesn't use, don't let the CLI judge health, and wait for the
    // services the app does use to actually answer instead.
    run_streaming(
        app,
        &root,
        &["start", "--exclude", "vector,logflare", "--ignore-health-check"],
    )?;
    let info = read_status(&root)?;
    wait_for_services(app, &info)?;
    emit_step(app, "migrate");
    run_streaming(app, &root, &["migration", "up", "--local"])?;
    emit_step(app, "cron");
    wire_cron(app);
    emit_step(app, "functions");
    start_functions(app, &root)?;
    emit_step(app, "ready");
    Ok(info)
}

#[tauri::command]
pub async fn start_stack(app: AppHandle) -> Result<StackInfo, String> {
    tauri::async_runtime::spawn_blocking(move || start_stack_blocking(&app))
        .await
        .map_err(err)?
}

/// On quit: stop the functions server, and `supabase stop` unless the user opted out.
/// `stop` keeps the database volume, so the workspace's data survives restarts.
/// Quitting from the launcher before the stack ever started leaves Docker alone.
pub fn shutdown(app: &AppHandle) {
    let functions = app
        .state::<StackState>()
        .functions
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take();
    let Some(mut child) = functions else {
        return;
    };
    terminate(&mut child);
    if !read_settings(app).stop_on_quit {
        return;
    }
    if let Ok(root) = stack_root(app) {
        if root.join("supabase").exists() {
            let _ = Command::new("supabase").arg("stop").current_dir(root).status();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_config_sets_project_id_and_ports() {
        let out = desktop_config("project_id = \"intranet\"\n\n[functions.chat]\nverify_jwt = true\n");
        assert!(out.starts_with("project_id = \"supanet-desktop\"\n"));
        assert!(!out.contains("intranet"));
        assert!(out.contains("[functions.chat]\nverify_jwt = true"));
        assert!(out.contains("[api]\nport = 55421"));
        assert!(out.contains("[db]\nport = 55422\nshadow_port = 55420"));
    }

    #[test]
    fn strip_ansi_removes_color_codes() {
        assert_eq!(
            strip_ansi("\u{1b}[31msupabase_db: unhealthy\u{1b}[39m"),
            "supabase_db: unhealthy"
        );
        assert_eq!(strip_ansi("plain [brackets] stay"), "plain [brackets] stay");
    }

    #[test]
    fn desktop_config_never_redefines_an_existing_table() {
        let out = desktop_config("[api]\nport = 1234\n");
        assert!(out.starts_with("project_id = \"supanet-desktop\"\n"));
        assert_eq!(out.matches("[api]").count(), 1);
        assert!(out.contains("port = 1234"));
        assert!(out.contains("[studio]\nport = 55423"));
    }
}

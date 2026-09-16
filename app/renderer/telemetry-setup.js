(async function () {
  "use strict";
  const primary = document.getElementById("primary");
  const secondary = document.getElementById("secondary");
  const message = document.getElementById("message");
  let status = await nexoSetup.status();

  document.getElementById("codex-file").textContent = status.codexFile;
  document.getElementById("claude-file").textContent = status.claudeFile;

  function setMessage(text, error = false) {
    message.textContent = text || "";
    message.classList.toggle("error", error);
  }

  function render() {
    if (status.enabled) {
      primary.innerHTML = "Repair integration <span>→</span>";
      secondary.textContent = "Disable integration";
      setMessage("Local telemetry is enabled for this Windows user.");
    } else {
      primary.innerHTML = "Enable local telemetry <span>→</span>";
      secondary.textContent = status.prompted ? "Close" : "Not now";
    }
  }

  primary.addEventListener("click", async () => {
    primary.disabled = true;
    secondary.disabled = true;
    setMessage("Creating backups and configuring local hooks…");
    try {
      status = await nexoSetup.enable();
      render();
    } catch (error) {
      setMessage(error?.message || "Telemetry setup failed. Your existing configuration was preserved.", true);
    } finally {
      primary.disabled = false;
      secondary.disabled = false;
    }
  });

  secondary.addEventListener("click", async () => {
    if (status.enabled) {
      secondary.disabled = true;
      try {
        const result = await nexoSetup.disable(false);
        status = result.status;
        setMessage("Nexo's wrapper was removed. Existing hooks were restored.");
        render();
      } catch (error) { setMessage(error?.message || "Could not restore the telemetry hooks.", true); }
      finally { secondary.disabled = false; }
    } else {
      if (!status.prompted) await nexoSetup.dismiss();
      nexoSetup.close();
    }
  });

  render();
})();

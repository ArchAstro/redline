(function (browserWindow, factory) {
  const catalog = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = catalog;
  }

  if (browserWindow?.document) {
    const start = () => catalog.initialize({
      window: browserWindow,
      document: browserWindow.document,
    });

    if (browserWindow.document.readyState === "loading") {
      browserWindow.document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }
})(typeof window === "undefined" ? null : window, function () {
  const interestKey = "archastro-oss-interest";
  const productionWaitlistEndpoint = "https://platform.archastro.ai/api/v1/developer/waitlist";

  function sanitizeInterestStore(store) {
    return Object.fromEntries(
      Object.entries(store || {}).map(([item, record]) => [
        item,
        {
          eventId: typeof record?.eventId === "string" ? record.eventId : "",
          interested: !!record?.interested,
          emailSaved: !!(
            record?.emailSaved || record?.emailSubmitted || record?.email
          ),
          emailLocalOnly: !!record?.emailLocalOnly,
          updatedAt: typeof record?.updatedAt === "string" ? record.updatedAt : "",
        },
      ])
    );
  }

  function readLocalInterest(storage) {
    if (!storage) return {};
    try {
      const raw = storage.getItem(interestKey) || "{}";
      const parsed = JSON.parse(raw);
      const sanitized = sanitizeInterestStore(parsed);
      const serialized = JSON.stringify(sanitized);
      if (serialized !== raw) storage.setItem(interestKey, serialized);
      return sanitized;
    } catch (_error) {
      return {};
    }
  }

  function saveLocalInterest(storage, item, payload, now) {
    if (!storage) throw new Error("Local storage unavailable");
    const store = readLocalInterest(storage);
    const saved = store[item] || {};
    store[item] = {
      eventId: payload.event_id || saved.eventId || "",
      interested: payload.interested ?? saved.interested ?? false,
      emailSaved: payload.emailSaved ?? saved.emailSaved ?? false,
      emailLocalOnly: payload.emailLocalOnly ?? saved.emailLocalOnly ?? false,
      updatedAt: now().toISOString(),
    };
    storage.setItem(interestKey, JSON.stringify(store));
    return store[item];
  }

  function isValidEventId(value) {
    return typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  function generateEventId(cryptoImpl = globalThis.crypto, random = Math.random) {
    const nativeId = cryptoImpl?.randomUUID?.();
    if (isValidEventId(nativeId)) return nativeId;

    const bytes = Array.from({ length: 16 }, () => Math.floor(random() * 256) & 0xff);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }

  function getOrCreateEventId(storage, item, createEventId, now) {
    const saved = readLocalInterest(storage)[item];
    if (isValidEventId(saved?.eventId)) return saved.eventId;

    const candidate = createEventId();
    const eventId = isValidEventId(candidate) ? candidate : generateEventId();
    try {
      saveLocalInterest(
        storage,
        item,
        { event_id: eventId },
        now
      );
    } catch (_error) {
      // The server can still accept the vote when browser storage is unavailable.
    }
    return eventId;
  }

  function rememberInterest(storage, item, payload, now) {
    try {
      saveLocalInterest(storage, item, payload, now);
    } catch (_error) {
      // A successful server response remains authoritative.
    }
  }

  function resolveInterestSubmission(location) {
    const hostname = location?.hostname || "";
    const loopbackPage = hostname === "localhost" || hostname === "127.0.0.1";
    const localPreview = loopbackPage || hostname === "";
    if (!localPreview) {
      return { isLocalPreview: false, endpoint: productionWaitlistEndpoint };
    }

    const params = new URLSearchParams(location?.search || "");
    if (!loopbackPage || params.get("oss_e2e") !== "1") {
      return { isLocalPreview: true, endpoint: null };
    }

    try {
      const endpoint = new URL(params.get("waitlist_endpoint") || "");
      const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
      if (loopback && ["http:", "https:"].includes(endpoint.protocol)) {
        return { isLocalPreview: false, endpoint: endpoint.href };
      }
    } catch (_error) {
      // Invalid E2E configuration stays private.
    }

    return { isLocalPreview: true, endpoint: null };
  }

  function platformPayload(payload) {
    const request = {
      source: payload.source,
      interest: payload.interest,
      action: payload.action,
      event_id: payload.event_id,
    };
    if (payload.action === "email_signup") {
      request.email = payload.email;
      request.project_updates = payload.project_updates;
      request.broader_updates = payload.broader_updates;
    }
    return request;
  }

  async function submitInterest(payload, options) {
    if (options.isLocalPreview) {
      return saveLocalInterest(
        options.storage,
        payload.interest,
        {
          ...payload,
          interested: payload.action === "thumbs_up",
          emailLocalOnly: payload.action === "email_signup",
        },
        options.now
      );
    }

    const response = await options.fetchImpl(options.endpoint || productionWaitlistEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(platformPayload(payload)),
    });

    if (!response.ok) {
      const error = new Error(`Interest endpoint returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return {
      interested: payload.action === "thumbs_up",
      emailSaved: payload.action === "email_signup",
    };
  }

  function showInterestForm(form) {
    form.hidden = false;
  }

  function markInterestSaved(button) {
    button.setAttribute("aria-pressed", "true");
    button.querySelector("[data-interest-label]").textContent = "Noted";
  }

  function markInterestRemoved(button) {
    button.setAttribute("aria-pressed", "false");
    button.querySelector("[data-interest-label]").textContent = "I'd use this";
  }

  function setInterestFormDisabled(form, disabled) {
    const emailInput = form.querySelector?.('[name="email"]');
    const submitButton = form.querySelector?.('button[type="submit"]');
    const broaderUpdatesInput = form.querySelector?.('[name="broader_updates"]');
    if (emailInput) emailInput.disabled = disabled;
    if (submitButton) submitButton.disabled = disabled;
    if (broaderUpdatesInput) broaderUpdatesInput.disabled = disabled;
  }

  function setNote(note, message, state) {
    note.hidden = false;
    note.textContent = message;
    note.dataset.state = state;
  }

  function bindInterestItem(options) {
    const {
      item,
      button,
      form,
      note,
      isLocalPreview,
      endpoint,
      fetchImpl,
      storage,
      now = () => new Date(),
      createEventId = generateEventId,
    } = options;
    const submitOptions = { isLocalPreview, endpoint, fetchImpl, storage, now };
    let eventId = getOrCreateEventId(storage, item, createEventId, now);
    const saved = readLocalInterest(storage)[item];
    let submitted = !!saved?.interested;
    let votePending = false;
    let emailPending = false;
    let emailSaved = !isLocalPreview && !!saved?.emailSaved;
    let emailLocalOnly = isLocalPreview && !!(saved?.emailLocalOnly || saved?.emailSaved);
    const projectName = item === "astrodev" ? "AstroDev" : `${item[0].toUpperCase()}${item.slice(1)}`;

    if (isLocalPreview && saved?.emailSaved) {
      rememberInterest(
        storage,
        item,
        { event_id: eventId, emailSaved: false, emailLocalOnly: true },
        now
      );
    }

    function emailSavedMessage(broaderUpdates = false) {
      return broaderUpdates
        ? `Email saved for ${projectName} and broader ArchAstro updates.`
        : `Email saved for ${projectName} updates.`;
    }

    if (saved?.interested) {
      showInterestForm(form);
      markInterestSaved(button);
    }
    if (emailLocalOnly) {
      setInterestFormDisabled(form, true);
      setNote(note, "Local preview only: email address was not sent or stored.", "local-only");
    } else if (emailSaved) {
      setInterestFormDisabled(form, true);
      setNote(note, emailSavedMessage(), "saved");
    } else if (saved?.interested) {
      setInterestFormDisabled(form, false);
      setNote(note, "Feedback saved. Add an email if you want an update.", "saved");
    }

    button.addEventListener("click", async () => {
      if (votePending || emailPending) return;
      const removing = submitted;
      if (!removing) showInterestForm(form);
      votePending = true;
      button.setAttribute("aria-busy", "true");
      setInterestFormDisabled(form, true);
      setNote(note, removing ? "Removing feedback..." : "Saving feedback...", "pending");
      try {
        await submitInterest(
          {
            interest: item,
            action: removing ? "remove_interest" : "thumbs_up",
            event_id: eventId,
            source: "oss_catalog_lab",
          },
          submitOptions
        );
        submitted = !removing;
        rememberInterest(storage, item, { event_id: eventId, interested: submitted }, now);
        if (removing) {
          markInterestRemoved(button);
          form.hidden = true;
          setInterestFormDisabled(form, true);
          setNote(
            note,
            emailSaved ? "Feedback removed. Email updates remain saved." : "Feedback removed.",
            "removed"
          );
        } else {
          markInterestSaved(button);
          setInterestFormDisabled(form, emailSaved || emailLocalOnly);
          if (emailSaved) {
            setNote(note, "Feedback saved. Email updates remain saved.", "saved");
          }
        }
        if (!removing && !emailPending && !emailSaved) {
          setNote(
            note,
            isLocalPreview
              ? "Local preview only: feedback is saved in this browser."
              : "Feedback saved. Add an email if you want an update.",
            "saved"
          );
        }
      } catch (_error) {
        if (!emailPending) {
          setNote(
            note,
            removing
              ? "Could not remove your feedback. Please try again."
              : "Could not save your feedback. Please try again.",
            "error"
          );
        }
      } finally {
        votePending = false;
        button.removeAttribute("aria-busy");
        setInterestFormDisabled(form, emailSaved || emailLocalOnly || !submitted);
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!submitted || votePending || emailPending || emailSaved || emailLocalOnly) return;
      const emailInput = form.querySelector('[name="email"]');
      const submitButton = form.querySelector('button[type="submit"]');
      const broaderUpdatesInput = form.querySelector('[name="broader_updates"]');
      const email = emailInput.value.trim();
      const broaderUpdates = !!broaderUpdatesInput?.checked;

      if (!email || !emailInput.checkValidity()) {
        setNote(note, "Enter a valid email address.", "error");
        emailInput.reportValidity();
        return;
      }

      emailPending = true;
      setInterestFormDisabled(form, true);
      setNote(note, "Saving email...", "pending");
      try {
        await submitInterest(
          {
            interest: item,
            action: "email_signup",
            event_id: eventId,
            email,
            project_updates: true,
            broader_updates: broaderUpdates,
            source: "oss_catalog_lab",
          },
          submitOptions
        );
        rememberInterest(
          storage,
          item,
          {
            event_id: eventId,
            interested: true,
            emailSaved: !isLocalPreview,
            emailLocalOnly: isLocalPreview,
          },
          now
        );
        emailSaved = !isLocalPreview;
        emailLocalOnly = isLocalPreview;
        setNote(
          note,
          isLocalPreview
            ? "Local preview only: email address was not sent or stored."
            : emailSavedMessage(broaderUpdates),
          isLocalPreview ? "local-only" : "saved"
        );
      } catch (_error) {
        setNote(note, "Request could not be completed. Please try again.", "error");
      } finally {
        emailPending = false;
        setInterestFormDisabled(form, emailSaved || emailLocalOnly);
      }
    });
  }

  function bindMotion(options) {
    const { media, status, reduceMotion, observeVisibility } = options;
    const defaultStatus = status.textContent;
    let visible = true;
    let failed = false;

    function pause(rewind = false) {
      media.pause();
      if (rewind) media.currentTime = 0;
    }

    async function syncPlayback() {
      if (failed) return;
      if (reduceMotion.matches) {
        pause(true);
        return;
      }
      if (!visible) {
        pause();
        return;
      }
      try {
        await media.play();
        status.textContent = defaultStatus;
      } catch (_error) {
        pause(true);
        status.textContent = "Recording unavailable.";
      }
    }

    media.addEventListener("error", () => {
      failed = true;
      pause(true);
      status.textContent = "Recording unavailable.";
    });
    reduceMotion.addEventListener("change", () => {
      void syncPlayback();
    });
    observeVisibility((isVisible) => {
      visible = isVisible;
      void syncPlayback();
    });

    void syncPlayback();
  }

  function bindRecordingDialog(options) {
    const { dialog, triggers, reduceMotion } = options;
    const media = dialog.querySelector("[data-recording-dialog-media]");
    const title = dialog.querySelector("[data-recording-dialog-title]");
    const caption = dialog.querySelector("[data-recording-dialog-caption]");
    const closeButton = dialog.querySelector("[data-recording-dialog-close]");
    let activeTrigger = null;
    let cleaned = true;

    async function open(trigger) {
      activeTrigger = trigger;
      cleaned = false;
      media.src = trigger.dataset.recordingSrc;
      media.poster = trigger.dataset.recordingPoster || "";
      title.textContent = `${trigger.dataset.recordingTitle} recording`;
      caption.textContent = trigger.dataset.recordingCaption;
      dialog.showModal();
      closeButton.focus?.();

      if (!reduceMotion.matches) {
        try {
          await media.play();
        } catch (_error) {
          // Native controls remain available when autoplay is blocked.
        }
      }
    }

    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      media.pause();
      media.currentTime = 0;
      media.removeAttribute("src");
      media.removeAttribute("poster");
      media.load();
      const trigger = activeTrigger;
      activeTrigger = null;
      trigger?.focus();
    }

    function close() {
      dialog.close();
      cleanup();
    }

    triggers.forEach((trigger) => {
      trigger.addEventListener("click", () => open(trigger));
    });
    closeButton.addEventListener("click", () => {
      close();
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) close();
    });
    dialog.addEventListener("close", cleanup);
  }

  function copyWithTextarea(command, options) {
    const textarea = options.document.createElement("textarea");
    textarea.value = command;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    options.document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    let copied = false;
    try {
      copied = options.document.execCommand("copy");
    } catch (_error) {
      copied = false;
    } finally {
      options.window.getSelection().removeAllRanges();
      textarea.remove();
    }
    return copied;
  }

  function bindClipboard(options) {
    const {
      button,
      status,
      commandElement,
      navigator,
      setTimeoutImpl,
    } = options;

    button.addEventListener("click", async () => {
      const command = commandElement.textContent.trim();
      let copied = false;
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
        await navigator.clipboard.writeText(command);
        copied = true;
      } catch (_error) {
        copied = copyWithTextarea(command, options);
      }

      if (copied) {
        button.textContent = "Copied";
        status.textContent = "Install command copied.";
        setTimeoutImpl(() => {
          button.textContent = "Copy";
          status.textContent = "";
        }, 1600);
      } else {
        button.textContent = "Copy";
        status.textContent = "Copy failed. Select the command and copy it manually.";
      }
    });
  }

  function initialize(options) {
    const { window, document } = options;
    const submission = resolveInterestSubmission(window.location);
    let storage;
    try {
      storage = window.localStorage;
    } catch (_error) {
      storage = null;
    }

    document.querySelectorAll("[data-lab-item]").forEach((itemElement) => {
      bindInterestItem({
        item: itemElement.dataset.labItem,
        button: itemElement.querySelector("[data-interest-button]"),
        form: itemElement.querySelector("[data-interest-form]"),
        note: itemElement.querySelector("[data-interest-note]"),
        ...submission,
        fetchImpl: window.fetch?.bind(window),
        storage,
      });
    });

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    document.querySelectorAll("[data-motion-proof]").forEach((proof) => {
      const media = proof.querySelector("[data-motion-media]");
      bindMotion({
        media,
        status: proof.querySelector("[data-motion-status]"),
        reduceMotion,
        observeVisibility(callback) {
          if (!window.IntersectionObserver) return;
          const observer = new window.IntersectionObserver(
            ([entry]) => callback(entry.isIntersecting),
            { threshold: 0.15 }
          );
          observer.observe(media);
        },
      });
    });

    const copyButton = document.querySelector("[data-copy-command]");
    const copyStatus = document.querySelector("[data-copy-status]");
    const commandElement = document.querySelector("[data-install-command]");
    if (copyButton && copyStatus && commandElement) {
      bindClipboard({
        button: copyButton,
        status: copyStatus,
        commandElement,
        document,
        window,
        navigator: window.navigator,
        setTimeoutImpl: window.setTimeout.bind(window),
      });
    }

    const recordingDialog = document.querySelector("[data-recording-dialog]");
    const recordingTriggers = document.querySelectorAll("[data-recording-trigger]");
    if (recordingDialog && recordingTriggers.length) {
      bindRecordingDialog({
        dialog: recordingDialog,
        triggers: recordingTriggers,
        reduceMotion,
      });
    }

  }

  return {
    bindClipboard,
    bindInterestItem,
    bindMotion,
    bindRecordingDialog,
    copyWithTextarea,
    createEventId: generateEventId,
    initialize,
    getOrCreateEventId,
    readLocalInterest,
    resolveInterestSubmission,
    submitInterest,
  };
});

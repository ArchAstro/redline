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

  function sanitizeInterestStore(store) {
    return Object.fromEntries(
      Object.entries(store || {}).map(([item, record]) => [
        item,
        {
          eventId: typeof record?.eventId === "string" ? record.eventId : "",
          signupEventId:
            typeof record?.signupEventId === "string"
              ? record.signupEventId
              : typeof record?.eventId === "string"
                ? record.eventId
                : "",
          interested: !!record?.interested,
          confirmationPending: !!(
            record?.confirmationPending || record?.emailSubmitted || record?.email
          ),
          deliveryStatus: ["queued", "pending-confirmation"].includes(record?.deliveryStatus)
            ? record.deliveryStatus
            : "",
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
      signupEventId:
        payload.signup_event_id || saved.signupEventId || payload.event_id || saved.eventId || "",
      interested: payload.interested ?? saved.interested ?? false,
      confirmationPending:
        payload.confirmationPending ??
        (payload.action === "email_signup" ? true : saved.confirmationPending ?? false),
      deliveryStatus:
        payload.deliveryStatus ??
        (payload.confirmationPending === false ? "" : saved.deliveryStatus ?? ""),
      updatedAt: now().toISOString(),
    };
    storage.setItem(interestKey, JSON.stringify(store));
    return store[item];
  }

  function getOrCreateEventId(storage, item, createEventId, now) {
    const saved = readLocalInterest(storage)[item];
    if (saved?.eventId) return saved.eventId;

    const eventId = createEventId();
    try {
      saveLocalInterest(
        storage,
        item,
        { event_id: eventId, interested: false },
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

  async function submitInterest(payload, options) {
    if (options.isLocalPreview) {
      return saveLocalInterest(
        options.storage,
        payload.item,
        { ...payload, interested: payload.action === "thumbs_up" },
        options.now
      );
    }

    const response = await options.fetchImpl("/api/oss/lab-interest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    let responseBody = null;
    if (typeof response.json === "function") {
      try {
        responseBody = await response.json();
      } catch (_error) {
        // A successful response with an empty or malformed body is still accepted.
      }
    }
    if (!response.ok) {
      const error = new Error(`Interest endpoint returned ${response.status}`);
      error.status = response.status;
      error.code = responseBody?.error?.code || "";
      throw error;
    }
    return {
      interested: payload.action === "thumbs_up",
      confirmationPending: payload.action === "email_signup",
      status: typeof responseBody?.status === "string" ? responseBody.status : null,
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
      fetchImpl,
      storage,
      now = () => new Date(),
      createEventId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      cooldownMs = 60_000,
      setTimeoutImpl = globalThis.setTimeout,
    } = options;
    const submitOptions = { isLocalPreview, fetchImpl, storage, now };
    let eventId = getOrCreateEventId(storage, item, createEventId, now);
    const saved = readLocalInterest(storage)[item];
    let signupEventId = saved?.signupEventId || eventId;
    let submitted = !!saved?.interested;
    let votePending = false;
    let emailPending = false;
    let confirmationPending = !!saved?.confirmationPending;
    let deliveryStatus = saved?.deliveryStatus || "";
    const projectName = item === "astrodev" ? "AstroDev" : `${item[0].toUpperCase()}${item.slice(1)}`;
    const submitButton = form.querySelector?.('button[type="submit"]');

    function confirmationMessage(broaderUpdates = false) {
      return broaderUpdates
        ? `Check your inbox to confirm ${projectName} and broader ArchAstro updates.`
        : `Check your inbox to confirm ${projectName} updates.`;
    }

    function removedConfirmationMessage(queued = false) {
      return queued
        ? "Your feedback was removed. Confirmation delivery is still queued."
        : "Your feedback was removed. Your email confirmation is still pending.";
    }

    function finishConfirmationCooldown() {
      confirmationPending = false;
      deliveryStatus = "";
      rememberInterest(
        storage,
        item,
        {
          event_id: eventId,
          interested: submitted,
          confirmationPending: false,
          deliveryStatus: "",
        },
        now
      );
      setInterestFormDisabled(form, false);
      if (submitButton) submitButton.textContent = "Send again";
      if (submitted) {
        setNote(note, "Didn't get it? You can send the confirmation again.", "retry");
      } else {
        setNote(note, "Feedback removed. Any confirmation email already sent remains valid.", "removed");
      }
    }

    function scheduleConfirmationCooldown(delay = cooldownMs) {
      const timer = setTimeoutImpl(finishConfirmationCooldown, Math.max(0, delay));
      timer?.unref?.();
    }

    if (saved?.interested) {
      showInterestForm(form);
      markInterestSaved(button);
    }
    if (confirmationPending) {
      setInterestFormDisabled(form, confirmationPending);
      const queued = deliveryStatus === "queued";
      setNote(
        note,
        saved?.interested
          ? queued
            ? "Confirmation delivery is delayed; we will retry shortly. You can send again in a minute."
            : confirmationMessage()
          : removedConfirmationMessage(queued),
        queued ? "queued" : "pending-confirmation"
      );
      const elapsed = Math.max(0, now().getTime() - Date.parse(saved.updatedAt || ""));
      const remaining = Number.isFinite(elapsed) ? cooldownMs - elapsed : cooldownMs;
      if (remaining > 0) scheduleConfirmationCooldown(remaining);
      else finishConfirmationCooldown();
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
            item,
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
          setInterestFormDisabled(form, confirmationPending);
          if (confirmationPending) {
            setNote(
              note,
              removedConfirmationMessage(deliveryStatus === "queued"),
              deliveryStatus === "queued" ? "queued" : "pending-confirmation"
            );
          } else {
            setNote(note, "Feedback removed.", "removed");
          }
        } else {
          markInterestSaved(button);
          setInterestFormDisabled(form, confirmationPending);
        }
        if (!removing && !emailPending && !confirmationPending) {
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
        setInterestFormDisabled(form, confirmationPending || !submitted);
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!submitted || votePending || emailPending || confirmationPending) return;
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
        const result = await submitInterest(
          {
            item,
            action: "email_signup",
            event_id: signupEventId,
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
              signup_event_id: signupEventId,
            interested: true,
            confirmationPending: true,
            deliveryStatus: result.status === "queued" ? "queued" : "pending-confirmation",
          },
          now
        );
        confirmationPending = true;
        deliveryStatus = result.status === "queued" ? "queued" : "pending-confirmation";
        const deliveryMessage =
          result.status === "queued"
            ? "Confirmation delivery is delayed; we will retry shortly. You can send again in a minute."
            : result.status === "pending_confirmation"
              ? confirmationMessage(broaderUpdates)
              : "Confirmation request accepted. Delivery status is unavailable; you can send again in a minute.";
        const deliveryState = result.status === "queued" ? "queued" : "pending-confirmation";
        setNote(
          note,
          isLocalPreview
            ? "Local preview only: confirmation request noted; the email address was not stored."
            : deliveryMessage,
          deliveryState
        );
        scheduleConfirmationCooldown();
      } catch (error) {
        if (error.code === "confirmation_delivery_failed") {
          signupEventId = createEventId();
          deliveryStatus = "";
          rememberInterest(
            storage,
            item,
            {
              signup_event_id: signupEventId,
              interested: true,
              confirmationPending: false,
              deliveryStatus: "",
            },
            now
          );
        }
        setNote(note, "Request could not be completed. Please try again.", "error");
      } finally {
        emailPending = false;
        setInterestFormDisabled(form, confirmationPending);
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
    const hostname = window.location?.hostname || "";
    const isLocalPreview = ["localhost", "127.0.0.1", ""].includes(hostname);
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
        isLocalPreview,
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
    initialize,
    getOrCreateEventId,
    readLocalInterest,
    submitInterest,
  };
});

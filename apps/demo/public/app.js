const state = {
  diagnostics: undefined,
  offers: [],
  offerInventoryError: undefined,
  offerResponse: undefined,
  resolutions: [],
  webhooks: [],
  webhookEvents: [],
  topology: undefined,
  lastReadiness: undefined,
  offerSurface: "detail",
  paymentAmountOfferId: undefined,
  webhookDeleteTarget: undefined,
  selectedResolutionId: undefined,
  recurringApproval: undefined,
  activityRefreshInFlight: false
};

const els = {};
const workspaceViews = new Set(["overview", "offers", "payments", "integrations", "network"]);

window.addEventListener("DOMContentLoaded", init);

async function init() {
  bindElements();
  bindEvents();
  els.webhookUrlInput.value = `${location.origin}/demo/webhook-receiver`;
  drawEmptyFingerprint();
  updateExportLinks();
  applyPricingMode();
  applyRecurrenceMode();
  renderOfferContext();
  renderWebhookSubscriptions();
  renderOperatorConsole();
  renderOfferDirectory();
  renderOverview();
  showView(viewFromLocationHash(), { updateLocation: false });
  await loadHealth();
  await loadOfferInventory();
  startLiveActivityPolling();

  const paymentOfferId = location.pathname.match(/^\/pay\/(0x[0-9a-f]{64})$/)?.[1];
  if (paymentOfferId) {
    showView("payments");
    await loadOffer(paymentOfferId, { updateLocation: false });
    return;
  }

  const selectedOfferId = selectedOfferIdFromLocation();
  if (selectedOfferId) {
    const selectedView = viewFromLocationHash();
    showView(workspaceViews.has(selectedView) ? selectedView : "offers", { updateLocation: false });
    await loadOffer(selectedOfferId, { updateLocation: false, silent: true });
  }
}

function bindElements() {
  for (const id of [
    "healthPill",
    "copyLinkButton",
    "paymentPageLink",
    "diagnosticMode",
    "diagnosticRpc",
    "refreshDiagnosticsButton",
    "newOfferButton",
    "cancelOfferCreateButton",
    "offerSearchInput",
    "offerList",
    "offerCount",
    "offerEmptyState",
    "offerDetailSurface",
    "offerTitle",
    "offerDetailSubtitle",
    "offerCreateSurface",
    "offerForm",
    "usernameInput",
    "descriptionInput",
    "minAmountInput",
    "minAmountLabel",
    "maxAmountInput",
    "maxAmountField",
    "assetInput",
    "pricingTypeInput",
    "typeHashField",
    "typeHashInput",
    "recurrenceEnabledInput",
    "recurrenceFields",
    "recurrenceIntervalInput",
    "recurrenceCyclesInput",
    "recurrenceCapInput",
    "recurrenceSecondsField",
    "recurrenceSecondsInput",
    "webhookUrlInput",
    "webhookForm",
    "registerWebhookButton",
    "openWebhookRegisterButton",
    "webhookRegisterDialog",
    "closeWebhookRegisterButton",
    "refreshWebhooksButton",
    "webhookCount",
    "webhookList",
    "webhookDetailsDialog",
    "webhookDetailsTitle",
    "webhookDetailsId",
    "webhookDetailsUrl",
    "webhookDetailsEvents",
    "webhookSecretValue",
    "copyWebhookSecretButton",
    "closeWebhookDetailsButton",
    "doneWebhookDetailsButton",
    "webhookDeleteDialog",
    "confirmWebhookDeleteButton",
    "cancelWebhookDeleteButton",
    "qrFrame",
    "qrImage",
    "offerCanvas",
    "offerState",
    "offerIdValue",
    "fiberAddressValue",
    "paymentLinkValue",
    "qrLinkValue",
    "qrOfferValue",
    "encodedOfferValue",
    "overviewOfferTotal",
    "overviewResolutionTotal",
    "overviewWebhookTotal",
    "overviewWorkerMode",
    "overviewSelectedOffer",
    "overviewSelectedOfferNote",
    "overviewNetworkValue",
    "overviewSelectedInvoiceCount",
    "overviewReadinessValue",
    "overviewOperatorValue",
    "overviewOperatorNote",
    "offerPreviewAsset",
    "offerPreviewDescription",
    "offerPreviewAddress",
    "offerPreviewRange",
    "offerPreviewPricing",
    "lookupInput",
    "resolveAddressButton",
    "payAmountLabel",
    "payAmountInput",
    "payAmountHint",
    "checkReadinessButton",
    "requestInvoiceButton",
    "recurrenceApprovalBox",
    "recurrenceApprovalTerms",
    "recurrenceApprovalButton",
    "markPaidButton",
    "refreshStatusButton",
    "readinessBox",
    "readinessSummary",
    "readinessList",
    "paymentBriefAsset",
    "paymentBriefAddress",
    "paymentBriefDescription",
    "paymentBriefAmountLabel",
    "paymentBriefRange",
    "reconciliationJsonLink",
    "reconciliationCsvLink",
    "webhookEventsLink",
    "deliverWebhooksButton",
    "operatorRefreshButton",
    "operatorSyncButton",
    "operatorRetryWebhooksButton",
    "operatorState",
    "operatorWorkersValue",
    "operatorSettlementValue",
    "operatorWebhookValue",
    "operatorLastRunValue",
    "operatorTimelineState",
    "operatorTimelineList",
    "operatorOutboxState",
    "operatorWebhookList",
    "operatorResultValue",
    "resolutionRows",
    "logCount",
    "invoiceDetailsDialog",
    "closeInvoiceDetailsButton",
    "invoiceDetailsTitle",
    "invoiceDetailsStatus",
    "invoiceDetailsAddress",
    "invoiceDetailsAmount",
    "invoiceDetailsAsset",
    "invoiceDetailsMode",
    "invoiceDetailsCreated",
    "invoiceDetailsUpdated",
    "invoiceDetailsExpiry",
    "invoiceDetailsInvoice",
    "invoiceDetailsPaymentHash",
    "invoiceDetailsResolutionId",
    "invoiceDetailsOfferId",
    "invoiceDetailsResolutionUrl",
    "invoiceDetailsReceipt",
    "invoiceDetailsSettlement",
    "invoiceDetailsHistory",
    "topologyState",
    "topologySummary",
    "topologyDirect",
    "topologyShared",
    "topologyPayerChannels",
    "topologyMerchantChannels",
    "topologyBlockers",
    "topologyActions",
    "toast"
  ]) {
    els[id] = document.getElementById(id);
  }
}

function bindEvents() {
  window.addEventListener("hashchange", () => showView(viewFromLocationHash(), { updateLocation: false }));
  document.addEventListener("toggle", handleActionMenuToggle, true);
  document.addEventListener("pointerdown", closeActionMenusFromOutsideClick);
  document.addEventListener("keydown", closeActionMenusFromKeyboard);
  document.addEventListener("click", closeActionMenuAfterSelection);
  for (const button of document.querySelectorAll(".nav-item[data-view]")) {
    button.addEventListener("click", () => showView(button.dataset.view));
  }
  for (const button of document.querySelectorAll("[data-view-target]")) {
    button.addEventListener("click", () => showView(button.dataset.viewTarget));
  }
  els.offerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await createOffer();
  });
  els.newOfferButton.addEventListener("click", openOfferCreate);
  els.cancelOfferCreateButton.addEventListener("click", () => setOfferSurface("detail"));
  els.offerSearchInput.addEventListener("input", renderOfferDirectory);
  els.assetInput.addEventListener("change", () => {
    els.typeHashField.classList.toggle("is-hidden", els.assetInput.value === "ckb");
    renderOfferDraft();
  });
  els.pricingTypeInput.addEventListener("change", applyPricingMode);
  els.recurrenceEnabledInput.addEventListener("change", applyRecurrenceMode);
  els.recurrenceIntervalInput.addEventListener("change", applyRecurrenceMode);
  els.recurrenceApprovalButton.addEventListener("click", toggleRecurringApproval);
  for (const input of [els.usernameInput, els.descriptionInput, els.minAmountInput, els.maxAmountInput]) {
    input.addEventListener("input", renderOfferDraft);
  }
  els.resolveAddressButton.addEventListener("click", resolveAddress);
  els.checkReadinessButton.addEventListener("click", checkReadiness);
  els.requestInvoiceButton.addEventListener("click", () => requestInvoice());
  els.markPaidButton.addEventListener("click", markLatestPaid);
  els.refreshStatusButton.addEventListener("click", refreshStatus);
  els.copyLinkButton.addEventListener("click", copyPaymentLink);
  els.refreshDiagnosticsButton.addEventListener("click", loadDiagnostics);
  els.webhookForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await registerWebhook();
  });
  els.openWebhookRegisterButton.addEventListener("click", () => els.webhookRegisterDialog.showModal());
  els.closeWebhookRegisterButton.addEventListener("click", () => els.webhookRegisterDialog.close());
  els.refreshWebhooksButton.addEventListener("click", refreshOperatorConsole);
  els.copyWebhookSecretButton.addEventListener("click", copyWebhookSecret);
  els.closeWebhookDetailsButton.addEventListener("click", () => els.webhookDetailsDialog.close());
  els.doneWebhookDetailsButton.addEventListener("click", () => els.webhookDetailsDialog.close());
  els.webhookDetailsDialog.addEventListener("close", () => {
    els.webhookSecretValue.textContent = "-";
  });
  els.confirmWebhookDeleteButton.addEventListener("click", deleteSelectedWebhook);
  els.webhookDeleteDialog.addEventListener("close", () => {
    state.webhookDeleteTarget = undefined;
  });
  els.deliverWebhooksButton.addEventListener("click", deliverWebhookEvents);
  els.operatorRefreshButton.addEventListener("click", refreshOperatorConsole);
  els.operatorSyncButton.addEventListener("click", syncCurrentOffer);
  els.operatorRetryWebhooksButton.addEventListener("click", retryCurrentOfferWebhooks);
  els.closeInvoiceDetailsButton.addEventListener("click", () => els.invoiceDetailsDialog.close());
  els.invoiceDetailsDialog.addEventListener("close", () => {
    state.selectedResolutionId = undefined;
  });
  els.invoiceDetailsDialog.addEventListener("click", (event) => {
    if (event.target === els.invoiceDetailsDialog) els.invoiceDetailsDialog.close();
  });
  for (const button of document.querySelectorAll(".invoice-copy-button")) {
    button.addEventListener("click", () => copyInvoiceDetail(button));
  }
}

function handleActionMenuToggle(event) {
  const menu = event.target;
  if (!(menu instanceof HTMLDetailsElement) || !menu.matches(".action-menu")) return;

  if (menu.open) {
    for (const openMenu of document.querySelectorAll(".action-menu[open]")) {
      if (openMenu !== menu) openMenu.removeAttribute("open");
    }
  }
  syncActionMenuLayers();
}

function closeActionMenusFromOutsideClick(event) {
  for (const menu of document.querySelectorAll(".action-menu[open]")) {
    if (!menu.contains(event.target)) menu.removeAttribute("open");
  }
  syncActionMenuLayers();
}

function closeActionMenusFromKeyboard(event) {
  if (event.key !== "Escape") return;
  const openMenu = document.querySelector(".action-menu[open]");
  if (!openMenu) return;

  openMenu.removeAttribute("open");
  openMenu.querySelector("summary")?.focus();
  syncActionMenuLayers();
}

function closeActionMenuAfterSelection(event) {
  const action = event.target.closest(".action-menu-item");
  if (!action) return;

  action.closest(".action-menu")?.removeAttribute("open");
  syncActionMenuLayers();
}

function syncActionMenuLayers() {
  for (const element of document.querySelectorAll(".has-open-action-menu")) {
    element.classList.remove("has-open-action-menu");
  }
  for (const menu of document.querySelectorAll(".action-menu[open]")) {
    menu.closest(".panel")?.classList.add("has-open-action-menu");
    menu.closest(".webhook-subscription")?.classList.add("has-open-action-menu");
  }
}

function showView(view, options = {}) {
  const requestedView = workspaceViews.has(view) ? view : "overview";
  const selectedView = requestedView === "network" && state.topology?.configured !== true ? "overview" : requestedView;
  for (const section of document.querySelectorAll("[data-workspace-view]")) {
    section.hidden = section.dataset.workspaceView !== selectedView;
  }
  for (const button of document.querySelectorAll(".nav-item[data-view]")) {
    const active = button.dataset.view === selectedView;
    button.classList.toggle("is-active", active);
    if (active) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  }
  if ((options.updateLocation !== false || selectedView !== requestedView) && location.hash !== `#${selectedView}`) {
    history.replaceState(null, "", `${location.pathname}${location.search}#${selectedView}`);
  }
}

function viewFromLocationHash() {
  return location.hash.replace(/^#/, "");
}

function selectedOfferIdFromLocation() {
  const offerId = new URL(location.href).searchParams.get("offer");
  return /^0x[0-9a-f]{64}$/.test(offerId ?? "") ? offerId : undefined;
}

function syncSelectedOfferLocation(offerId, view = viewFromLocationHash()) {
  if (!offerId || location.pathname.startsWith("/pay/")) return;
  const url = new URL(location.href);
  url.searchParams.set("offer", offerId);
  url.hash = workspaceViews.has(view) && (view !== "network" || state.topology?.configured === true) ? view : "offers";
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

async function loadHealth() {
  try {
    const health = await api("/health");
    const mockMode = health.invoice_mode === "mock";
    els.healthPill.textContent = mockMode ? "Mock invoices" : "Fiber RPC";
    els.healthPill.classList.toggle("is-mock", mockMode);
    setTone(els.healthPill, mockMode ? "warn" : "ok");
    await loadDiagnostics();
  } catch {
    els.healthPill.textContent = "Offline";
    els.healthPill.classList.remove("is-mock");
    setTone(els.healthPill, "error");
  }
}

async function loadDiagnostics() {
  try {
    const [diagnostics, topology] = await Promise.all([api("/diagnostics"), api("/topology")]);
    state.diagnostics = diagnostics;
    renderDiagnostics(diagnostics);
    renderTopology(topology);
    renderOperatorWorkers(diagnostics.workers);
  } catch {
    els.diagnosticMode.textContent = "offline";
    els.diagnosticRpc.textContent = "unreachable";
    setTone(els.diagnosticRpc, "error");
    renderTopologyError();
    renderOperatorWorkers(undefined);
  }
}

async function loadOfferInventory() {
  try {
    const response = await api("/offers");
    state.offers = response.offers ?? [];
    state.offerInventoryError = undefined;
  } catch (error) {
    state.offers = [];
    state.offerInventoryError = error.message;
  }
  renderOfferDirectory();
  renderOverview();
}

function openOfferCreate() {
  showView("offers");
  setOfferSurface("create");
}

function setOfferSurface(surface) {
  state.offerSurface = surface;
  const hasSelectedOffer = Boolean(state.offerResponse?.offer_id);
  const create = surface === "create";

  els.offerCreateSurface.hidden = !create;
  els.offerDetailSurface.hidden = create || !hasSelectedOffer;
  els.offerEmptyState.hidden = create || hasSelectedOffer;
}

async function selectOffer(offerId) {
  showView("offers");
  setOfferSurface("detail");
  await loadOffer(offerId, { view: "offers" });
}

function renderOfferDirectory() {
  const query = els.offerSearchInput?.value.trim().toLowerCase() ?? "";
  const selectedOfferId = state.offerResponse?.offer_id;
  const offers = state.offers.filter((offer) => {
    const searchText = [offer.description, offer.fiber_address, offer.offer_id, offer.assets?.[0]?.symbol].join(" ").toLowerCase();
    return searchText.includes(query);
  });

  els.offerCount.textContent = `${state.offers.length}`;
  els.offerList.replaceChildren();

  if (state.offerInventoryError) {
    const message = document.createElement("p");
    message.className = "offer-list-message";
    const error = state.offerInventoryError.toLowerCase();
    message.textContent = error.includes("route was not found")
      ? "This resolver version does not support offer inventory. Restart it with the current server code."
      : error.includes("unauthorized")
        ? "Operator access is required to list offers. Configure the resolver API key."
        : `Offer inventory is unavailable: ${state.offerInventoryError}`;
    els.offerList.append(message);
    return;
  }

  if (offers.length === 0) {
    const message = document.createElement("p");
    message.className = "offer-list-message";
    message.textContent = state.offers.length === 0 ? "No offers yet" : "No offers match this search";
    els.offerList.append(message);
    return;
  }

  for (const offer of offers) {
    const asset = offer.assets?.[0];
    const item = document.createElement("button");
    item.type = "button";
    item.className = "offer-list-item";
    item.classList.toggle("is-selected", offer.offer_id === selectedOfferId);
    item.setAttribute("aria-pressed", String(offer.offer_id === selectedOfferId));

    const head = document.createElement("span");
    head.className = "offer-list-head";
    const title = document.createElement("strong");
    title.textContent = offer.description || offer.fiber_address || "Untitled offer";
    const status = document.createElement("span");
    status.className = `offer-list-state ${offer.disabled ? "is-disabled" : "is-live"}`;
    status.textContent = offer.disabled ? "Paused" : "Live";
    head.append(title, status);

    const address = document.createElement("span");
    address.className = "offer-list-address";
    address.textContent = offer.fiber_address ?? shortHash(offer.offer_id);
    const meta = document.createElement("span");
    meta.className = "offer-list-meta";
    const amount = document.createElement("span");
    amount.className = "offer-list-amount";
    amount.textContent = offerAmountRange(offer);
    const assetBadge = document.createElement("span");
    assetBadge.className = "offer-list-asset";
    assetBadge.textContent = asset?.symbol ?? "Asset";
    meta.append(amount, assetBadge);

    item.append(head, address, meta);
    item.addEventListener("click", () => selectOffer(offer.offer_id));
    els.offerList.append(item);
  }
}

function renderOverview() {
  const store = state.diagnostics?.store;
  const selected = state.offerResponse;
  const workerEnabled = state.diagnostics?.workers?.enabled;
  const readiness = state.lastReadiness;

  els.overviewOfferTotal.textContent = String(state.offerInventoryError ? store?.offers ?? 0 : state.offers.length);
  els.overviewResolutionTotal.textContent = String(store?.resolution_count ?? 0);
  els.overviewWebhookTotal.textContent = String(store?.webhook_event_count ?? 0);
  els.overviewWorkerMode.textContent = workerEnabled ? "Enabled" : "Manual";

  if (!selected?.offer) {
    els.overviewSelectedOffer.textContent = "No offer selected";
    els.overviewSelectedOfferNote.textContent = "Choose an endpoint from Offers to inspect its payment link and activity.";
    els.overviewNetworkValue.textContent = "-";
    els.overviewSelectedInvoiceCount.textContent = "-";
    els.overviewReadinessValue.textContent = "Not checked";
    els.overviewOperatorValue.textContent = workerEnabled ? "Workers enabled" : "Manual operator";
    els.overviewOperatorNote.textContent = workerEnabled
      ? "Settlement and webhook workers are available for selected offers."
      : "Create or select an offer to open the payment and delivery workflows.";
    return;
  }

  const pendingDeliveries = state.webhookEvents
    .flatMap((event) => event.deliveries ?? [])
    .filter((delivery) => delivery.status !== "delivered").length;
  els.overviewSelectedOffer.textContent = selected.fiber_address ?? selected.offer.description ?? shortHash(selected.offer_id);
  els.overviewSelectedOfferNote.textContent = selected.offer.description ?? "Signed payment endpoint";
  els.overviewNetworkValue.textContent = selected.offer.network ?? "-";
  els.overviewSelectedInvoiceCount.textContent = String(state.resolutions.length);
  els.overviewReadinessValue.textContent = readiness
    ? readiness.ready
      ? `Ready${readiness.confidence ? ` · ${readiness.confidence}` : ""}`
      : "Needs attention"
    : "Not checked";
  els.overviewOperatorValue.textContent = pendingDeliveries > 0 ? `${pendingDeliveries} pending` : "Healthy";
  els.overviewOperatorNote.textContent = pendingDeliveries > 0
    ? "Review pending webhook deliveries in Integrations."
    : "This offer has no pending webhook deliveries.";
}

async function createOffer() {
  setBusy(true);
  try {
    const pricingMode = selectedPricingMode();
    const payload = {
      username: els.usernameInput.value,
      description: els.descriptionInput.value,
      pricing_type: pricingMode,
      ...(pricingMode === "fixed" ? { amount: els.minAmountInput.value } : { amount_min: els.minAmountInput.value }),
      ...(pricingMode === "range" ? { amount_max: els.maxAmountInput.value } : {}),
      assets: [selectedAsset()],
      ...(recurrenceDraft() ? { recurrence: recurrenceDraft() } : {})
    };
    const created = await api("/demo/offers", {
      method: "POST",
      body: payload
    });

    state.offerResponse = created;
    state.resolutions = [];
    state.webhooks = [];
    state.webhookEvents = [];
    state.recurringApproval = undefined;
    els.lookupInput.value = els.usernameInput.value;
    els.payAmountInput.value = els.minAmountInput.value;
    renderOffer();
    renderLog();
    renderOperatorConsole();
    resetReadiness();
    await loadDiagnostics();
    await loadOfferInventory();
    setOfferSurface("detail");
    showView("offers");
    syncSelectedOfferLocation(created.offer_id);
    toast("Offer created");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function loadOffer(offerId, options = {}) {
  setBusy(true);
  try {
    state.offerResponse = await api(`/offers/${offerId}`);
    await refreshOperatorData();
    renderOffer();
    resetReadiness();
    setOfferSurface("detail");
    renderOfferDirectory();
    if (options.updateLocation !== false) syncSelectedOfferLocation(offerId, options.view);
    if (!options.silent) toast("Offer loaded");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function resolveAddress() {
  setBusy(true);
  try {
    const username = els.lookupInput.value.trim();
    const resolved = await api(`/.well-known/fiberoffer/${encodeURIComponent(username)}`);
    state.offerResponse = resolved;
    await refreshOperatorData();
    renderOffer();
    resetReadiness();
    renderOfferDirectory();
    syncSelectedOfferLocation(resolved.offer_id, "payments");
    toast("Address resolved");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function requestInvoice() {
  if (!state.offerResponse?.offer_id) {
    toast("Create or resolve an offer first", true);
    return undefined;
  }

  setBusy(true);
  try {
    const resolution = await api(`/offers/${state.offerResponse.offer_id}/invoice`, {
      method: "POST",
      body: currentPaymentRequest()
    });

    const item = resolutionFromInvoiceResponse(resolution);
    state.resolutions.unshift(item);
    renderLog();
    await refreshOperatorData();
    await loadDiagnostics();
    toast("Invoice created");
    return resolution;
  } catch (error) {
    toast(error.message, true);
    return undefined;
  } finally {
    setBusy(false);
  }
}

async function checkReadiness() {
  if (!state.offerResponse?.offer_id) {
    toast("Create or resolve an offer first", true);
    return undefined;
  }

  setBusy(true);
  try {
    const readiness = await api(`/offers/${state.offerResponse.offer_id}/check`, {
      method: "POST",
      body: currentPaymentRequest({ includeInvoice: true })
    });
    renderReadiness(readiness);
    toast(readiness.ready ? `Readiness confidence: ${readiness.confidence ?? "unknown"}` : "Payment needs attention", !readiness.ready);
    return readiness;
  } catch (error) {
    toast(error.message, true);
    return undefined;
  } finally {
    setBusy(false);
  }
}

async function markLatestPaid() {
  const latest = state.resolutions[0];
  if (!state.offerResponse?.offer_id || !latest?.id) {
    toast("Request an invoice first", true);
    return;
  }

  setBusy(true);
  try {
    const updated = await api(`/offers/${state.offerResponse.offer_id}/resolutions/${latest.id}/status`, {
      method: "POST",
      body: {
        status: "invoice_paid",
        source: "demo",
        settlement_reference: `demo-${Date.now()}`
      }
    });
    state.resolutions[0] = resolutionFromRecord(updated);
    renderLog();
    await refreshOperatorData();
    await loadDiagnostics();
    toast("Latest invoice marked paid");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function refreshStatus() {
  if (!state.offerResponse?.offer_id) {
    toast("Create or resolve an offer first", true);
    return;
  }

  setBusy(true);
  try {
    await refreshOperatorData();
    await loadDiagnostics();
    toast("Statuses refreshed");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function refreshResolutions() {
  await refreshOperatorData();
}

async function refreshOperatorData() {
  if (!state.offerResponse?.offer_id) {
    state.resolutions = [];
    state.webhooks = [];
    state.webhookEvents = [];
    renderLog();
    renderWebhookSubscriptions();
    renderOperatorConsole();
    return;
  }

  const [resolutions, events, webhooks] = await Promise.all([
    api(`/offers/${state.offerResponse.offer_id}/resolutions`),
    api(`/offers/${state.offerResponse.offer_id}/webhook-events`),
    api(`/offers/${state.offerResponse.offer_id}/webhooks`)
  ]);
  state.resolutions = resolutions.resolutions
    .slice()
    .reverse()
    .map((record) => resolutionFromRecord(record));
  state.webhookEvents = events.events ?? [];
  state.webhooks = webhooks.webhooks ?? [];
  renderLog();
  renderWebhookSubscriptions();
  renderOperatorConsole();
}

function startLiveActivityPolling() {
  window.setInterval(async () => {
    if (
      document.visibilityState !== "visible" ||
      !state.offerResponse?.offer_id ||
      state.activityRefreshInFlight
    ) {
      return;
    }

    state.activityRefreshInFlight = true;
    try {
      await refreshOperatorData();
    } catch {
      // Background refresh is best effort; explicit actions still surface API errors.
    } finally {
      state.activityRefreshInFlight = false;
    }
  }, 10_000);
}

function renderOffer() {
  const response = state.offerResponse;
  if (!response) return;

  els.offerTitle.textContent = response.offer.description || "Untitled offer";
  els.offerDetailSubtitle.textContent = response.fiber_address ?? "Signed payment endpoint";
  els.offerState.textContent = `Active · ${response.offer.network}`;
  setTone(els.offerState, "ok");
  els.offerIdValue.textContent = response.offer_id;
  els.fiberAddressValue.textContent = response.fiber_address ?? "-";
  els.paymentLinkValue.textContent = response.payment_link;
  els.paymentPageLink.href = response.payment_link;
  els.qrImage.src = response.qr_link_url;
  els.qrFrame.classList.add("has-qr");
  els.qrLinkValue.href = response.qr_link_url;
  els.qrOfferValue.href = response.qr_offer_url;
  els.encodedOfferValue.value = response.encoded_offer;
  updateExportLinks(response.offer_id);
  drawFingerprint(response.offer_id);
  renderOfferContext(response);
  renderOverview();
}

function renderOfferContext(response = state.offerResponse) {
  if (!response?.offer) {
    els.paymentBriefAsset.textContent = "-";
    els.paymentBriefAddress.textContent = "No offer selected";
    els.paymentBriefDescription.textContent = "-";
    els.paymentBriefAmountLabel.textContent = "Accepted range";
    els.paymentBriefRange.textContent = "-";
    applyPaymentAmountMode();
    renderRecurrenceApproval();
    return;
  }

  const offer = response.offer;
  const asset = offer.assets?.[0];
  els.paymentBriefAsset.textContent = asset?.symbol ?? "-";
  els.paymentBriefAddress.textContent = response.fiber_address ?? "-";
  els.paymentBriefDescription.textContent = offer.description ?? "-";
  els.paymentBriefAmountLabel.textContent = fixedOfferAmount(offer) ? "Fixed amount" : "Accepted range";
  els.paymentBriefRange.textContent = offerAmountRange(offer, asset);
  applyPaymentAmountMode(offer, asset);
  renderRecurrenceApproval(offer);
}

function renderOfferDraft() {
  const asset = selectedAsset();
  const pricingMode = selectedPricingMode();
  const username = els.usernameInput.value.trim() || "your-offer";
  const description = els.descriptionInput.value.trim() || "Untitled payment offer";
  const minimum = els.minAmountInput.value.trim() || "0";
  const maximum = els.maxAmountInput.value.trim() || "Open";
  const price =
    pricingMode === "fixed"
      ? `${minimum} ${asset.symbol}`
      : pricingMode === "open"
        ? `From ${minimum} ${asset.symbol}`
        : `${minimum} - ${maximum} ${asset.symbol}`;

  els.offerPreviewAsset.textContent = asset.symbol;
  els.offerPreviewDescription.textContent = description;
  els.offerPreviewAddress.textContent = `${username}@${location.host}`;
  els.offerPreviewRange.textContent = price;
  els.offerPreviewPricing.textContent = pricingModeLabel(pricingMode);
}

function applyPricingMode() {
  const pricingMode = selectedPricingMode();
  els.maxAmountField.classList.toggle("is-hidden", pricingMode !== "range");
  els.minAmountLabel.textContent = pricingMode === "fixed" ? "Amount" : "Minimum amount";
  els.minAmountInput.name = pricingMode === "fixed" ? "amount" : "amount_min";
  renderOfferDraft();
}

function applyRecurrenceMode() {
  const enabled = els.recurrenceEnabledInput.checked;
  els.recurrenceFields.classList.toggle("is-hidden", !enabled);
  els.recurrenceSecondsField.classList.toggle(
    "is-hidden",
    !enabled || els.recurrenceIntervalInput.value !== "custom_seconds"
  );
}

function recurrenceDraft() {
  if (!els.recurrenceEnabledInput.checked) return undefined;
  return {
    interval: els.recurrenceIntervalInput.value,
    amount: els.minAmountInput.value,
    cap_cycles: els.recurrenceCyclesInput.value,
    spending_cap_total: els.recurrenceCapInput.value,
    ...(els.recurrenceIntervalInput.value === "custom_seconds"
      ? { custom_seconds: els.recurrenceSecondsInput.value }
      : {})
  };
}

function renderRecurrenceApproval(offer) {
  const terms = offer?.recurrence;
  els.recurrenceApprovalBox.classList.toggle("is-hidden", !terms);
  if (!terms) {
    state.recurringApproval = undefined;
    els.requestInvoiceButton.disabled = false;
    return;
  }
  const caps = [
    terms.cap_cycles === undefined ? undefined : `${terms.cap_cycles} cycles`,
    terms.spending_cap_total === undefined ? undefined : `${terms.spending_cap_total} total`
  ].filter(Boolean).join(" / ");
  els.recurrenceApprovalTerms.textContent = `${terms.amount} ${offer.assets?.[0]?.symbol ?? ""} · ${terms.interval} · cap ${caps}`;
  const approved = state.recurringApproval?.offer_id === offer.offer_id;
  els.recurrenceApprovalButton.textContent = approved ? "Revoke approval" : "Approve recurring payment";
  els.requestInvoiceButton.disabled = !approved;
}

function toggleRecurringApproval() {
  const offer = state.offerResponse?.offer;
  if (!offer?.recurrence) return;
  if (state.recurringApproval?.offer_id === offer.offer_id) {
    state.recurringApproval = undefined;
    toast("Recurring approval revoked");
  } else {
    state.recurringApproval = { offer_id: offer.offer_id, approved_at: new Date().toISOString() };
    toast("Recurring payment approved");
  }
  renderRecurrenceApproval(offer);
}

function selectedPricingMode() {
  return els.pricingTypeInput.value ?? "fixed";
}

function pricingModeLabel(mode) {
  if (mode === "open") return "Customer chooses";
  if (mode === "range") return "Amount range";
  return "Fixed amount";
}

function offerAmountRange(offer, asset) {
  const minimum = offer.amount_min ?? "0";
  const maximum = offer.amount_max ?? "Open";
  const symbol = asset?.symbol ?? "";
  if (offer.amount_max !== undefined && String(minimum) === String(maximum)) return `${minimum} ${symbol}`.trim();
  if (offer.amount_max === undefined) return `From ${minimum} ${symbol}`.trim();
  return `${minimum} - ${maximum} ${symbol}`.trim();
}

function fixedOfferAmount(offer) {
  if (offer?.amount_min === undefined || offer.amount_max === undefined) return undefined;
  return String(offer.amount_min) === String(offer.amount_max) ? String(offer.amount_min) : undefined;
}

function applyPaymentAmountMode(offer = undefined, asset = undefined) {
  const fixedAmount = fixedOfferAmount(offer);
  const symbol = asset?.symbol ?? offer?.assets?.[0]?.symbol ?? "";
  const suffix = symbol ? ` ${symbol}` : "";
  const selectionChanged = offer?.offer_id !== state.paymentAmountOfferId;
  state.paymentAmountOfferId = offer?.offer_id;

  if (fixedAmount) {
    els.payAmountInput.value = fixedAmount;
    els.payAmountInput.readOnly = true;
    els.payAmountInput.classList.add("is-fixed-amount");
    els.payAmountLabel.textContent = "Fixed amount";
    els.payAmountHint.textContent = `This offer always requests ${fixedAmount}${suffix}.`;
    return;
  }

  els.payAmountInput.readOnly = false;
  els.payAmountInput.classList.remove("is-fixed-amount");
  els.payAmountLabel.textContent = "Amount";

  if (selectionChanged && offer?.amount_min !== undefined) {
    els.payAmountInput.value = offer.amount_min;
  }

  if (!offer) {
    els.payAmountHint.textContent = "Resolve an offer to see its pricing rules.";
  } else if (offer.amount_max !== undefined) {
    els.payAmountHint.textContent = `Enter an amount from ${offer.amount_min ?? "0"} to ${offer.amount_max}${suffix}.`;
  } else if (offer.amount_min !== undefined) {
    els.payAmountHint.textContent = `Enter an amount of at least ${offer.amount_min}${suffix}.`;
  } else {
    els.payAmountHint.textContent = "Enter the amount to pay.";
  }
}

async function registerWebhook() {
  if (!state.offerResponse?.offer_id) {
    toast("Create or resolve an offer first", true);
    return;
  }

  setBusy(true);
  try {
    const webhook = await api(`/offers/${state.offerResponse.offer_id}/webhooks`, {
      method: "POST",
      body: {
        url: els.webhookUrlInput.value,
        events: selectedWebhookEvents()
      }
    });
    els.webhookRegisterDialog.close();
    showWebhookDetails(webhook, "Webhook registered");
    await refreshOperatorData();
    await loadDiagnostics();
    toast("Webhook endpoint registered");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(false);
  }
}

function selectedWebhookEvents() {
  return Array.from(document.querySelectorAll('input[name="webhook_event"]:checked'), (input) => input.value);
}

function showWebhookDetails(webhook, title) {
  if (!webhook?.signing_secret) return;
  els.webhookDetailsTitle.textContent = title;
  els.webhookDetailsId.textContent = webhook.id ?? "-";
  els.webhookDetailsUrl.textContent = webhook.url ?? "-";
  els.webhookDetailsEvents.textContent = (webhook.events ?? []).join(", ") || "-";
  els.webhookSecretValue.textContent = webhook.signing_secret;
  els.webhookDetailsDialog.showModal();
}

async function copyWebhookSecret() {
  const secret = els.webhookSecretValue.textContent;
  if (!secret || secret === "-") return;
  try {
    await navigator.clipboard.writeText(secret);
    toast("Signing secret copied");
  } catch {
    toast(secret);
  }
}

async function testWebhook(webhookId) {
  if (!state.offerResponse?.offer_id) return;
  setBusy(true);
  try {
    const result = await api(`/offers/${state.offerResponse.offer_id}/webhooks/${webhookId}/test`, {
      method: "POST",
      body: {}
    });
    renderOperatorResult(result);
    await refreshOperatorData();
    toast(result.delivered === 1 ? "Test event delivered" : "Test event failed", result.delivered !== 1);
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function toggleWebhook(webhookId, disabled) {
  if (!state.offerResponse?.offer_id) return;
  setBusy(true);
  try {
    await api(`/offers/${state.offerResponse.offer_id}/webhooks/${webhookId}`, {
      method: "PATCH",
      body: { disabled }
    });
    await refreshOperatorData();
    toast(disabled ? "Webhook paused" : "Webhook resumed");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function rotateWebhookSecret(webhookId) {
  if (!state.offerResponse?.offer_id) return;
  setBusy(true);
  try {
    const webhook = await api(`/offers/${state.offerResponse.offer_id}/webhooks/${webhookId}/rotate-secret`, {
      method: "POST",
      body: {}
    });
    showWebhookDetails(webhook, "Signing secret rotated");
    await refreshOperatorData();
    toast("Signing secret rotated");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(false);
  }
}

function requestWebhookDelete(webhookId) {
  state.webhookDeleteTarget = webhookId;
  els.webhookDeleteDialog.showModal();
}

async function deleteSelectedWebhook(event) {
  event.preventDefault();
  const webhookId = state.webhookDeleteTarget;
  if (!state.offerResponse?.offer_id || !webhookId) return;
  setBusy(true);
  try {
    await api(`/offers/${state.offerResponse.offer_id}/webhooks/${webhookId}`, { method: "DELETE" });
    els.webhookDeleteDialog.close();
    await refreshOperatorData();
    await loadDiagnostics();
    toast("Webhook endpoint deleted");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function deliverWebhookEvents() {
  if (!state.offerResponse?.offer_id) {
    toast("Create or resolve an offer first", true);
    return;
  }

  setBusy(true);
  try {
    const result = await api(`/offers/${state.offerResponse.offer_id}/webhook-events/deliver`, {
      method: "POST",
      body: { retry_failed: false }
    });
    renderOperatorResult(result);
    await refreshOperatorData();
    await loadDiagnostics();
    toast(`Webhook delivery: ${result.delivered} delivered, ${result.failed} failed`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function refreshOperatorConsole() {
  setBusy(true);
  try {
    await Promise.all([loadDiagnostics(), refreshOperatorData()]);
    toast("Operator console refreshed");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function syncCurrentOffer() {
  if (!state.offerResponse?.offer_id) {
    toast("Create or resolve an offer first", true);
    return;
  }

  setBusy(true);
  try {
    const result = await api(`/offers/${state.offerResponse.offer_id}/resolutions/sync`, {
      method: "POST",
      body: { include_terminal: false }
    });
    renderOperatorResult(result);
    await refreshOperatorData();
    await loadDiagnostics();
    toast(`Sync: ${result.changed} changed, ${result.failed} failed`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function retryCurrentOfferWebhooks() {
  if (!state.offerResponse?.offer_id) {
    toast("Create or resolve an offer first", true);
    return;
  }

  setBusy(true);
  try {
    const result = await api(`/offers/${state.offerResponse.offer_id}/webhook-events/deliver`, {
      method: "POST",
      body: { retry_failed: true }
    });
    renderOperatorResult(result);
    await refreshOperatorData();
    await loadDiagnostics();
    toast(`Webhooks: ${result.delivered} delivered, ${result.failed} failed`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(false);
  }
}

function renderDiagnostics(diagnostics) {
  els.diagnosticMode.textContent = diagnostics.invoice_mode;
  setTone(els.diagnosticMode, diagnostics.invoice_mode === "mock" ? "warn" : "ok");

  if (diagnostics.invoice_source.mode === "mock") {
    els.diagnosticRpc.textContent = "mock";
    setTone(els.diagnosticRpc, "warn");
  } else if (diagnostics.invoice_source.reachable) {
    els.diagnosticRpc.textContent = "reachable";
    setTone(els.diagnosticRpc, "ok");
  } else {
    els.diagnosticRpc.textContent = "error";
    setTone(els.diagnosticRpc, "error");
  }

  renderOverview();
}

function renderOperatorWorkers(workers) {
  if (!workers) {
    els.operatorWorkersValue.textContent = "-";
    els.operatorSettlementValue.textContent = "-";
    els.operatorWebhookValue.textContent = "-";
    els.operatorLastRunValue.textContent = "-";
    renderOverview();
    return;
  }

  els.operatorWorkersValue.textContent = workers.enabled ? "enabled" : "disabled";
  els.operatorSettlementValue.textContent = workerTaskSummary(workers.settlement_sync);
  els.operatorWebhookValue.textContent = workerTaskSummary(workers.webhook_delivery);
  els.operatorLastRunValue.textContent = latestWorkerRun(workers) ?? "-";
  renderOverview();
}

function renderTopology(topology) {
  state.topology = topology;
  setPairTopologyAvailability(topology?.configured === true);

  if (!topology?.configured) {
    els.topologyState.textContent = "Optional";
    setTone(els.topologyState);
    els.topologySummary.textContent =
      "No payer fixture is connected. Merchant invoice creation and settlement monitoring do not require one.";
    els.topologyDirect.textContent = "-";
    els.topologyShared.textContent = "-";
    els.topologyPayerChannels.textContent = "-";
    els.topologyMerchantChannels.textContent = "-";
    renderIssueList(els.topologyBlockers, [], "No merchant blocker");
    renderTextList(els.topologyActions, [
      "Configure PAYER_FIBER_RPC_URL only for a controlled pair topology or end-to-end test."
    ]);
    return;
  }

  const tone = topology.status === "ready" ? "ok" : topology.status === "blocked" || topology.status === "error" ? "error" : "warn";
  els.topologyState.textContent = topology.status;
  setTone(els.topologyState, tone);
  els.topologySummary.textContent = topology.summary ?? topology.error?.message ?? "-";
  els.topologyDirect.textContent = topology.direct_channel?.usable_for_payer_to_merchant
    ? "ready"
    : topology.direct_channel?.opening
      ? "opening"
      : "not ready";
  els.topologyShared.textContent = `${topology.online_common_channel_counterparties?.length ?? 0}/${topology.common_channel_counterparties?.length ?? 0} online`;
  els.topologyPayerChannels.textContent = channelSummary(topology.payer?.channels, topology.payer?.pending_channels);
  els.topologyMerchantChannels.textContent = channelSummary(
    topology.merchant?.channels,
    topology.merchant?.pending_channels
  );
  renderIssueList(els.topologyBlockers, topology.blockers ?? [], "No blockers");
  renderTextList(els.topologyActions, topology.next_actions ?? []);
}

function renderTopologyError() {
  state.topology = undefined;
  setPairTopologyAvailability(false);
  els.topologyState.textContent = "Error";
  setTone(els.topologyState, "error");
  els.topologySummary.textContent = "Topology report could not be loaded";
  els.topologyDirect.textContent = "-";
  els.topologyShared.textContent = "-";
  els.topologyPayerChannels.textContent = "-";
  els.topologyMerchantChannels.textContent = "-";
  renderIssueList(els.topologyBlockers, [], "Unavailable");
  renderTextList(els.topologyActions, ["Refresh diagnostics after the resolver is reachable."]);
}

function setPairTopologyAvailability(available) {
  for (const control of document.querySelectorAll("[data-payer-topology-control]")) {
    control.hidden = !available;
    control.classList.toggle("is-hidden", !available);
  }

  if (!available) {
    const networkView = document.querySelector('[data-workspace-view="network"]');
    if (networkView && !networkView.hidden) showView("overview");
  }
}

function renderIssueList(element, issues, emptyText) {
  element.replaceChildren();

  if (issues.length === 0) {
    const item = document.createElement("li");
    item.textContent = emptyText;
    element.append(item);
    return;
  }

  for (const issue of issues) {
    const item = document.createElement("li");
    const code = document.createElement("strong");
    const summary = document.createElement("span");
    code.textContent = issue.code ?? "INFO";
    summary.textContent = issue.summary ?? issue.message ?? "-";
    item.append(code, summary);
    element.append(item);
  }
}

function renderTextList(element, values) {
  element.replaceChildren();

  if (!values || values.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No next action";
    element.append(item);
    return;
  }

  for (const value of values.slice(0, 5)) {
    const item = document.createElement("li");
    item.textContent = value;
    element.append(item);
  }
}

function channelSummary(channels, pendingChannels) {
  if (!channels) return "-";
  const pending = pendingChannels?.opening ? `, ${pendingChannels.opening} opening` : "";
  return `${channels.enabled ?? 0} ready, ${channels.usable_outbound ?? 0} out${pending}`;
}

function renderReadiness(readiness) {
  const ready = Boolean(readiness.ready);
  state.lastReadiness = readiness;
  els.readinessBox.classList.toggle("is-ready", ready);
  els.readinessBox.classList.toggle("is-blocked", !ready);
  els.readinessSummary.textContent = readiness.summary ?? (ready ? "Ready to request invoice" : "Fix request before invoicing");
  els.readinessList.replaceChildren();

  for (const check of readiness.checks) {
    const row = document.createElement("li");
    const status = document.createElement("span");
    const message = document.createElement("span");
    status.className = `readiness-status ${check.status}`;
    status.textContent = check.status;
    message.textContent = check.message;
    row.append(status, message);
    els.readinessList.append(row);
  }

  const nextAction = readiness.next_actions?.[0];
  if (nextAction) {
    const row = document.createElement("li");
    const status = document.createElement("span");
    const message = document.createElement("span");
    status.className = "readiness-status info";
    status.textContent = "next";
    message.textContent = nextAction;
    row.append(status, message);
    els.readinessList.append(row);
  }

  renderOverview();
}

function resetReadiness() {
  state.lastReadiness = undefined;
  els.readinessBox.classList.remove("is-ready", "is-blocked");
  els.readinessSummary.textContent = "Not checked";
  els.readinessList.replaceChildren();
  renderOverview();
}

function renderWebhookSubscriptions() {
  const webhooks = state.webhooks ?? [];
  els.webhookCount.textContent = `${webhooks.length} endpoint${webhooks.length === 1 ? "" : "s"}`;
  els.webhookList.replaceChildren();

  if (!state.offerResponse?.offer_id) {
    const empty = document.createElement("p");
    empty.className = "webhook-empty";
    empty.textContent = "Select an offer to manage its webhook endpoints.";
    els.webhookList.append(empty);
    return;
  }

  if (webhooks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "webhook-empty";
    empty.textContent = "No webhook endpoints registered for this offer.";
    els.webhookList.append(empty);
    return;
  }

  for (const webhook of webhooks) {
    const row = document.createElement("article");
    row.className = "webhook-subscription";

    const heading = document.createElement("div");
    heading.className = "webhook-subscription-heading";
    const identity = document.createElement("div");
    identity.className = "webhook-subscription-identity";
    const url = document.createElement("a");
    url.href = webhook.url;
    url.target = "_blank";
    url.rel = "noreferrer";
    url.textContent = webhook.url;
    const id = document.createElement("code");
    id.textContent = webhook.id;
    identity.append(url, id);
    const status = document.createElement("span");
    status.className = `status-chip ${webhook.disabled ? "webhook-paused" : "webhook-active"}`;
    status.textContent = webhook.disabled ? "Paused" : "Active";
    const controls = document.createElement("div");
    controls.className = "webhook-heading-controls";
    heading.append(identity, controls);

    const events = document.createElement("div");
    events.className = "webhook-event-tags";
    for (const eventName of webhook.events ?? []) {
      const tag = document.createElement("span");
      tag.textContent = eventName;
      events.append(tag);
    }

    const metadata = document.createElement("div");
    metadata.className = "webhook-subscription-meta";
    const secret = document.createElement("span");
    secret.className = webhook.secret_hint ? "" : "is-warning";
    secret.textContent = `Secret ${webhook.secret_hint ?? "not configured"}`;
    const delivery = document.createElement("span");
    delivery.textContent = webhookDeliverySummary(webhook.id);
    const updated = document.createElement("span");
    updated.textContent = `Updated ${formatTime(webhook.updated_at)}`;
    metadata.append(secret, delivery, updated);

    const menu = document.createElement("details");
    menu.className = "action-menu";
    const menuButton = document.createElement("summary");
    menuButton.setAttribute("aria-label", `Actions for ${webhook.url}`);
    menuButton.textContent = "⋮";
    const menuItems = document.createElement("div");
    menuItems.className = "action-menu-items";
    const testButton = webhookActionButton("Send test", () => testWebhook(webhook.id));
    testButton.disabled = webhook.disabled;
    const stateButton = webhookActionButton(webhook.disabled ? "Resume" : "Pause", () =>
      toggleWebhook(webhook.id, !webhook.disabled)
    );
    const rotateButton = webhookActionButton("Rotate secret", () => rotateWebhookSecret(webhook.id));
    const deleteButton = webhookActionButton("Delete", () => requestWebhookDelete(webhook.id), "action-menu-item is-danger");
    menuItems.append(testButton, stateButton, rotateButton, deleteButton);
    menu.append(menuButton, menuItems);
    controls.append(status, menu);

    row.append(heading, events, metadata);
    els.webhookList.append(row);
  }
}

function webhookActionButton(label, action, className = "action-menu-item") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function webhookDeliverySummary(webhookId) {
  const deliveries = (state.webhookEvents ?? [])
    .flatMap((event) => event.deliveries ?? [])
    .filter((delivery) => delivery.webhook_id === webhookId);
  if (deliveries.length === 0) return "No deliveries";
  const delivered = deliveries.filter((delivery) => delivery.status === "delivered").length;
  const failed = deliveries.filter((delivery) => delivery.status === "failed").length;
  const pending = deliveries.filter((delivery) => delivery.status === "pending").length;
  return `${delivered} delivered · ${pending} pending · ${failed} failed`;
}

function renderOperatorConsole() {
  const latest = state.resolutions[0];
  const events = state.webhookEvents ?? [];
  const pendingDeliveries = events
    .flatMap((event) => event.deliveries ?? [])
    .filter((delivery) => delivery.status !== "delivered").length;

  els.operatorState.textContent = state.offerResponse ? `${state.resolutions.length} invoices` : "No offer";
  setTone(els.operatorState, state.offerResponse ? (pendingDeliveries > 0 ? "warn" : "ok") : "warn");
  els.operatorTimelineState.textContent = latest?.status ? String(latest.status).replace("invoice_", "") : "-";
  els.operatorOutboxState.textContent = `${pendingDeliveries} pending`;
  renderTimeline(latest);
  renderWebhookOutbox(events);
  renderOverview();
}

function renderTimeline(resolution) {
  els.operatorTimelineList.replaceChildren();

  if (!resolution) {
    appendOperatorItem(els.operatorTimelineList, "No invoices yet", "Request an invoice to create a timeline.");
    return;
  }

  const history = resolution.status_history?.length
    ? resolution.status_history
    : [{ status: resolution.status, at: resolution.updated_at ?? resolution.created_at, source: "resolver" }];

  for (const event of history.slice().reverse().slice(0, 6)) {
    appendOperatorItem(
      els.operatorTimelineList,
      String(event.status ?? "unknown").replace("invoice_", ""),
      `${formatTime(event.at)} · ${event.source ?? "unknown"}${event.note ? ` · ${event.note}` : ""}`
    );
  }
}

function renderWebhookOutbox(events) {
  els.operatorWebhookList.replaceChildren();

  if (!events || events.length === 0) {
    appendOperatorItem(els.operatorWebhookList, "No webhook events", "Register a webhook and request an invoice.");
    return;
  }

  for (const event of events.slice().reverse().slice(0, 6)) {
    const deliveries = event.deliveries ?? [];
    const delivered = deliveries.filter((delivery) => delivery.status === "delivered").length;
    const failed = deliveries.filter((delivery) => delivery.status === "failed").length;
    const pending = deliveries.filter((delivery) => delivery.status === "pending").length;
    const detail =
      deliveries.length === 0
        ? "no subscriptions"
        : `${delivered}/${deliveries.length} delivered · ${pending} pending · ${failed} failed`;
    appendOperatorItem(els.operatorWebhookList, event.type ?? "event", `${formatTime(event.created_at)} · ${detail}`);
  }
}

function renderOperatorResult(result) {
  const summary = removeUndefined({
    offer_id: result.offer_id,
    checked: result.checked,
    changed: result.changed,
    skipped: result.skipped,
    attempted: result.attempted,
    delivered: result.delivered,
    failed: result.failed
  });
  els.operatorResultValue.textContent = JSON.stringify(summary, null, 2);
}

function appendOperatorItem(element, title, detail) {
  const item = document.createElement("li");
  const strong = document.createElement("strong");
  const span = document.createElement("span");
  strong.textContent = title;
  span.textContent = detail;
  item.append(strong, span);
  element.append(item);
}

function setTone(element, tone) {
  element.classList.remove("is-ok", "is-warn", "is-error");
  if (tone) element.classList.add(`is-${tone}`);
}

function renderLog() {
  els.logCount.textContent = `${state.resolutions.length} invoice${state.resolutions.length === 1 ? "" : "s"}`;
  els.resolutionRows.replaceChildren();

  if (state.resolutions.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "empty-cell";
    cell.textContent = "No invoices yet";
    row.append(cell);
    els.resolutionRows.append(row);
    if (els.invoiceDetailsDialog.open) els.invoiceDetailsDialog.close();
    renderOverview();
    return;
  }

  for (const item of state.resolutions) {
    const row = document.createElement("tr");
    row.className = "resolution-row";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `View invoice ${shortHash(item.payment_hash)} details`);
    row.append(tableCell(new Date(item.created_at).toLocaleTimeString()));
    row.append(tableCell(item.amount));
    row.append(tableCell(item.asset.symbol));
    row.append(statusCell(item.status));
    row.append(tableCell(shortHash(item.payment_hash)));
    row.append(tableCell(item.invoice_mode ?? item.mode ?? "mock"));
    row.addEventListener("click", () => openInvoiceDetails(item.id));
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openInvoiceDetails(item.id);
    });
    els.resolutionRows.append(row);
  }
  if (state.selectedResolutionId && els.invoiceDetailsDialog.open) renderInvoiceDetails();
  renderOverview();
}

function openInvoiceDetails(resolutionId) {
  state.selectedResolutionId = resolutionId;
  renderInvoiceDetails();
  if (!els.invoiceDetailsDialog.open) els.invoiceDetailsDialog.showModal();
}

function renderInvoiceDetails() {
  const resolution = state.resolutions.find((item) => item.id === state.selectedResolutionId);
  if (!resolution) {
    if (els.invoiceDetailsDialog.open) els.invoiceDetailsDialog.close();
    return;
  }

  const offerId = resolution.offer_id ?? state.offerResponse?.offer_id;
  const resolutionUrl = resolution.invoice_url ??
    (offerId ? `${location.origin}/offers/${offerId}/resolutions/${resolution.id}` : undefined);
  const receiptUrl = resolution.receipt_url ??
    (offerId ? `${location.origin}/offers/${offerId}/resolutions/${resolution.id}/receipt.json` : undefined);
  const status = String(resolution.status ?? "unknown");
  els.invoiceDetailsTitle.textContent = state.offerResponse?.offer?.description || "Payment invoice";
  els.invoiceDetailsStatus.className = `status-chip ${status.replaceAll("_", "-")}`;
  els.invoiceDetailsStatus.textContent = status.replace("invoice_", "");
  els.invoiceDetailsAddress.textContent = state.offerResponse?.fiber_address ?? "-";
  els.invoiceDetailsAmount.textContent = resolution.amount ?? "-";
  els.invoiceDetailsAsset.textContent = resolution.asset?.symbol ?? "-";
  els.invoiceDetailsMode.textContent = resolution.invoice_mode ?? resolution.mode ?? "-";
  els.invoiceDetailsCreated.textContent = formatDateTime(resolution.created_at);
  els.invoiceDetailsUpdated.textContent = formatDateTime(resolution.updated_at);
  els.invoiceDetailsExpiry.textContent = formatDateTime(resolution.expires_at);
  els.invoiceDetailsInvoice.textContent = resolution.invoice ?? "-";
  els.invoiceDetailsPaymentHash.textContent = resolution.payment_hash ?? "-";
  els.invoiceDetailsResolutionId.textContent = resolution.id ?? "-";
  els.invoiceDetailsOfferId.textContent = offerId ?? "-";
  els.invoiceDetailsResolutionUrl.textContent = resolutionUrl ?? "-";
  els.invoiceDetailsResolutionUrl.href = resolutionUrl ?? "#";
  els.invoiceDetailsResolutionUrl.dataset.copyValue = resolutionUrl ?? "";
  els.invoiceDetailsReceipt.textContent = receiptUrl ?? "-";
  els.invoiceDetailsReceipt.href = receiptUrl ?? "#";
  els.invoiceDetailsReceipt.dataset.copyValue = receiptUrl ?? "";
  renderInvoiceSettlement(resolution.settlement);
  renderInvoiceHistory(resolution);
}

function renderInvoiceSettlement(settlement) {
  els.invoiceDetailsSettlement.replaceChildren();
  const entries = Object.entries(settlement ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "invoice-settlement-empty";
    empty.textContent = "No settlement data yet.";
    els.invoiceDetailsSettlement.append(empty);
    return;
  }

  for (const [key, value] of entries) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = key.replaceAll("_", " ");
    detail.textContent = typeof value === "object" ? JSON.stringify(value) : String(value);
    row.append(term, detail);
    els.invoiceDetailsSettlement.append(row);
  }
}

function renderInvoiceHistory(resolution) {
  els.invoiceDetailsHistory.replaceChildren();
  const history = resolution.status_history?.length
    ? resolution.status_history
    : [{ status: resolution.status, at: resolution.updated_at ?? resolution.created_at, source: "resolver" }];

  for (const event of history.slice().reverse()) {
    const item = document.createElement("li");
    const marker = document.createElement("span");
    const content = document.createElement("div");
    const status = document.createElement("strong");
    const detail = document.createElement("span");
    marker.className = "invoice-history-marker";
    status.textContent = String(event.status ?? "unknown").replace("invoice_", "");
    detail.textContent = `${formatDateTime(event.at)} · ${event.source ?? "unknown"}${event.note ? ` · ${event.note}` : ""}`;
    content.append(status, detail);
    item.append(marker, content);
    els.invoiceDetailsHistory.append(item);
  }
}

async function copyInvoiceDetail(button) {
  const target = document.getElementById(button.dataset.copyTarget);
  const value = target?.dataset.copyValue || target?.textContent?.trim();
  if (!value || value === "-") return;

  try {
    await navigator.clipboard.writeText(value);
    toast(`${button.dataset.copyLabel ?? "Value"} copied`);
  } catch {
    toast(value);
  }
}

function updateExportLinks(offerId) {
  if (!offerId) {
    els.reconciliationJsonLink.href = "#";
    els.reconciliationCsvLink.href = "#";
    els.webhookEventsLink.href = "#";
    els.deliverWebhooksButton.disabled = true;
    els.reconciliationJsonLink.classList.add("is-disabled");
    els.reconciliationCsvLink.classList.add("is-disabled");
    els.webhookEventsLink.classList.add("is-disabled");
    return;
  }

  els.reconciliationJsonLink.href = `/offers/${offerId}/reconciliation.json`;
  els.reconciliationCsvLink.href = `/offers/${offerId}/reconciliation.csv`;
  els.webhookEventsLink.href = `/offers/${offerId}/webhook-events`;
  els.deliverWebhooksButton.disabled = false;
  els.reconciliationJsonLink.classList.remove("is-disabled");
  els.reconciliationCsvLink.classList.remove("is-disabled");
  els.webhookEventsLink.classList.remove("is-disabled");
}

function resolutionFromInvoiceResponse(resolution) {
  return {
    id: resolution.resolution_id,
    offer_id: resolution.offer_id ?? state.offerResponse?.offer_id,
    status: resolution.status,
    amount: resolution.amount,
    asset: resolution.asset,
    invoice: resolution.invoice,
    payment_hash: resolution.payment_hash,
    invoice_mode: resolution.invoice_mode,
    expires_at: resolution.expires_at,
    invoice_url: resolution.invoice_url,
    receipt_url: resolution.receipt_url,
    status_history: resolution.status_history,
    settlement: resolution.settlement,
    recurrence: resolution.recurrence,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

function resolutionFromRecord(record) {
  return {
    id: record.id,
    offer_id: record.offer_id,
    status: record.status,
    amount: record.amount,
    asset: record.asset,
    invoice: record.invoice?.invoice,
    payment_hash: record.payment_hash ?? record.invoice?.payment_hash,
    invoice_mode: record.invoice?.mode,
    expires_at: record.invoice?.expires_at,
    invoice_url: record.invoice_url,
    receipt_url: record.receipt_url,
    status_history: record.status_history,
    settlement: record.settlement,
    recurrence: record.recurrence,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

function currentPaymentRequest(options = {}) {
  const request = {
    amount: els.payAmountInput.value,
    asset: state.offerResponse.offer.assets[0]
  };
  if (state.offerResponse.offer.recurrence) {
    request.recurrence_cycle = state.resolutions.filter((resolution) => resolution.recurrence).length + 1;
    request.approval_id = state.recurringApproval?.offer_id;
  }
  const latest = state.resolutions[0];
  if (
    options.includeInvoice &&
    state.topology?.configured === true &&
    latest?.invoice &&
    latest.amount === request.amount &&
    sameAsset(latest.asset, request.asset)
  ) {
    request.invoice = latest.invoice;
  }

  return request;
}

function sameAsset(left, right) {
  if (!left || !right) return false;
  return (
    left.asset_type === right.asset_type &&
    (left.symbol ?? "") === (right.symbol ?? "") &&
    (left.type_script_hash ?? "") === (right.type_script_hash ?? "")
  );
}

function selectedAsset() {
  const type = els.assetInput.value;
  if (type === "ckb") return { asset_type: "ckb", symbol: "CKB" };

  return {
    asset_type: "udt",
    symbol: "UDT",
    type_script_hash: els.typeHashInput.value || `0x${"1".repeat(64)}`
  };
}

function tableCell(value) {
  const cell = document.createElement("td");
  cell.textContent = value ?? "-";
  return cell;
}

function workerTaskSummary(task) {
  if (!task) return "-";
  const stateText = task.running ? "running" : `${task.pass_count ?? 0} passes`;
  return `${stateText}, ${task.error_count ?? 0} errors`;
}

function latestWorkerRun(workers) {
  const timestamps = [workers.settlement_sync?.last_finished_at, workers.webhook_delivery?.last_finished_at].filter(Boolean);
  if (timestamps.length === 0) return undefined;
  return formatTime(timestamps.sort().at(-1));
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleTimeString();
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function statusCell(status) {
  const cell = document.createElement("td");
  const chip = document.createElement("span");
  chip.className = `status-chip ${String(status).replaceAll("_", "-")}`;
  chip.textContent = String(status ?? "unknown").replace("invoice_", "");
  cell.append(chip);
  return cell;
}

async function copyPaymentLink() {
  const link = state.offerResponse?.payment_link;
  if (!link) {
    toast("No payment link to copy", true);
    return;
  }

  try {
    await navigator.clipboard.writeText(link);
    toast("Payment link copied");
  } catch {
    toast(link);
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error?.message ?? `Request failed with ${response.status}`);
  }
  return body;
}

function drawEmptyFingerprint() {
  const canvas = els.offerCanvas;
  const context = canvas.getContext("2d");
  context.fillStyle = "#191b1e";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#3b3f44";
  context.fillRect(30, 30, 108, 108);
  context.fillStyle = "#191b1e";
  context.fillRect(42, 42, 84, 84);
}

function drawFingerprint(offerId) {
  const canvas = els.offerCanvas;
  const context = canvas.getContext("2d");
  const cells = 12;
  const cell = canvas.width / cells;
  const hex = offerId.replace("0x", "");

  context.fillStyle = "#191b1e";
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < cells; y += 1) {
    for (let x = 0; x < cells; x += 1) {
      const index = (x + y * cells) % hex.length;
      const value = Number.parseInt(hex[index], 16);
      if ((value + x + y) % 3 === 0) {
        context.fillStyle = value % 2 === 0 ? "#3cc9aa" : "#d9b96e";
        context.fillRect(x * cell + 2, y * cell + 2, cell - 4, cell - 4);
      }
    }
  }

  context.strokeStyle = "#3b3f44";
  context.lineWidth = 2;
  context.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
}

function shortHash(value) {
  if (!value) return "-";
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

function setBusy(isBusy) {
  for (const button of document.querySelectorAll("button")) {
    if (isBusy) {
      button.dataset.disabledBeforeBusy = String(button.disabled);
      button.disabled = true;
    } else if (button.dataset.disabledBeforeBusy !== undefined) {
      button.disabled = button.dataset.disabledBeforeBusy === "true";
      delete button.dataset.disabledBeforeBusy;
    }
  }
}

let toastTimer;
function toast(message, isError = false) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.toggle("is-error", isError);
  els.toast.classList.add("is-visible");
  toastTimer = setTimeout(() => els.toast.classList.remove("is-visible"), 2600);
}

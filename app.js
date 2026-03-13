const DATA_URL = './data/grants.json';
const PAGE_STEP = 50;
const STATUS_OPTIONS = [
  { id: 'live', label: 'Live', matches: new Set(['31094501', '31094502']) },
  { id: '31094502', label: 'Open', matches: new Set(['31094502']) },
  { id: '31094501', label: 'Forthcoming', matches: new Set(['31094501']) }
];

const state = {
  data: null,
  filtered: [],
  visibleCount: PAGE_STEP,
  filters: {
    query: '',
    status: 'live',
    programme: 'all',
    sort: 'start-desc'
  }
};

const elements = {
  searchInput: document.querySelector('#search-input'),
  statusPills: document.querySelector('#status-pills'),
  programmeSelect: document.querySelector('#programme-select'),
  sortSelect: document.querySelector('#sort-select'),
  resetButton: document.querySelector('#reset-button'),
  metricTotal: document.querySelector('#metric-total'),
  metricLive: document.querySelector('#metric-live'),
  metricBudget: document.querySelector('#metric-budget'),
  lastUpdated: document.querySelector('#last-updated'),
  sourceCount: document.querySelector('#source-count'),
  resultsCount: document.querySelector('#results-count'),
  resultsHeadline: document.querySelector('#results-headline'),
  resultsList: document.querySelector('#results-list'),
  loadMoreButton: document.querySelector('#load-more-button'),
  closingSoon: document.querySelector('#closing-soon'),
  topProgrammes: document.querySelector('#top-programmes'),
  grantCardTemplate: document.querySelector('#grant-card-template')
};

const compactNumber = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const moneyCompact = new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR', notation: 'compact', maximumFractionDigits: 1 });
const dateFormatter = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });
const relativeFormatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function parseHash() {
  const hash = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(hash);

  state.filters.query = params.get('q') || '';
  state.filters.status = params.get('s') || 'live';
  state.filters.programme = params.get('p') || 'all';
  state.filters.sort = params.get('sort') || 'start-desc';
}

function writeHash() {
  const params = new URLSearchParams();

  if (state.filters.query) params.set('q', state.filters.query);
  if (state.filters.status !== 'live') params.set('s', state.filters.status);
  if (state.filters.programme !== 'all') params.set('p', state.filters.programme);
  if (state.filters.sort !== 'start-desc') params.set('sort', state.filters.sort);

  const nextHash = params.toString();
  const nextUrl = `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ''}`;
  window.history.replaceState(null, '', nextUrl);
}

function formatDate(value) {
  if (!value) return 'TBA';
  return dateFormatter.format(new Date(value));
}

function formatRelative(dateString) {
  if (!dateString) return 'No deadline';
  const difference = new Date(dateString).getTime() - Date.now();
  const days = Math.round(difference / (1000 * 60 * 60 * 24));
  return relativeFormatter.format(days, 'day');
}

function formatCurrency(value) {
  if (!value) return 'Unknown';
  return moneyCompact.format(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getPrimaryProgramme(grant) {
  return grant.frameworkProgrammes[0]?.label || grant.programmeDivisions[0]?.label || grant.callIdentifier?.split('-')[0] || 'Programme unavailable';
}

function getStatusOption(id) {
  return STATUS_OPTIONS.find((option) => option.id === id) || STATUS_OPTIONS[0];
}

function filterGrants() {
  const query = state.filters.query.trim().toLowerCase();
  const statusOption = getStatusOption(state.filters.status);

  state.filtered = state.data.grants
    .filter((grant) => {
      if (statusOption.matches && !statusOption.matches.has(grant.status.id)) {
        return false;
      }

      if (state.filters.programme !== 'all') {
        const programIds = new Set(grant.frameworkProgrammes.map((programme) => programme.id));
        if (!programIds.has(state.filters.programme)) {
          return false;
        }
      }

      if (query && !grant.searchText.toLowerCase().includes(query)) {
        return false;
      }

      return true;
    })
    .sort((left, right) => {
      switch (state.filters.sort) {
        case 'deadline-asc': {
          return (new Date(left.deadlineDate || '2999-12-31').getTime()) - (new Date(right.deadlineDate || '2999-12-31').getTime());
        }
        case 'budget-desc': {
          return (right.budget?.totalBudgetEur || 0) - (left.budget?.totalBudgetEur || 0);
        }
        case 'title-asc': {
          return left.title.localeCompare(right.title);
        }
        case 'start-desc':
        default: {
          return (new Date(right.startDate || 0).getTime()) - (new Date(left.startDate || 0).getTime());
        }
      }
    });
}

function renderStatusPills() {
  elements.statusPills.innerHTML = '';
  const counts = state.data.summary.byStatus;

  for (const option of STATUS_OPTIONS) {
    const count = option.id === 'live'
      ? state.data.summary.total
      : (counts[option.id] || 0);

    const button = document.createElement('button');
    button.className = `status-pill${state.filters.status === option.id ? ' is-active' : ''}`;
    button.type = 'button';
    button.textContent = `${option.label} (${compactNumber.format(count)})`;
    button.addEventListener('click', () => {
      state.filters.status = option.id;
      state.visibleCount = PAGE_STEP;
      syncControls();
      update();
    });
    elements.statusPills.appendChild(button);
  }
}

function renderProgrammeOptions() {
  const option = document.createElement('option');
  option.value = 'all';
  option.textContent = 'All programmes';
  elements.programmeSelect.appendChild(option);

  for (const programme of state.data.facets.frameworkProgramme) {
    const nextOption = document.createElement('option');
    nextOption.value = programme.rawValue;
    nextOption.textContent = `${programme.value} (${compactNumber.format(programme.count)})`;
    elements.programmeSelect.appendChild(nextOption);
  }
}

function renderMetrics() {
  const openCount = state.data.summary.byStatus['31094502'] || 0;
  elements.metricTotal.textContent = compactNumber.format(state.data.summary.total);
  elements.metricLive.textContent = compactNumber.format(openCount);
  elements.metricBudget.textContent = formatCurrency(state.data.summary.knownBudgetEur);
  elements.lastUpdated.textContent = formatDate(state.data.generatedAt);
  elements.sourceCount.textContent = `${compactNumber.format(state.data.source.totalResults)} calls from the official EU index`;
}

function renderMiniList(container, items, formatter) {
  container.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'mini-list__item';
    empty.textContent = 'No items in this slice.';
    container.appendChild(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'mini-list__item';
    row.innerHTML = formatter(item);
    container.appendChild(row);
  }
}

function renderSidebar() {
  const openSoon = state.data.grants
    .filter((grant) => grant.status.id === '31094502' && grant.deadlineDate)
    .sort((left, right) => new Date(left.deadlineDate).getTime() - new Date(right.deadlineDate).getTime())
    .slice(0, 5);

  renderMiniList(elements.closingSoon, openSoon, (grant) => `
    <div class="mini-list__title">${escapeHtml(grant.identifier)}</div>
    <div class="mini-list__meta">${escapeHtml(formatDate(grant.deadlineDate))} · ${escapeHtml(formatRelative(grant.deadlineDate))}</div>
  `);

  renderMiniList(elements.topProgrammes, state.data.facets.frameworkProgramme.slice(0, 6), (programme) => `
    <div class="mini-list__title">${escapeHtml(programme.value)}</div>
    <div class="mini-list__meta">${escapeHtml(compactNumber.format(programme.count))} calls</div>
  `);
}

function createFact(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function renderResults() {
  const visible = state.filtered.slice(0, state.visibleCount);
  elements.resultsList.innerHTML = '';

  elements.resultsCount.textContent = `${compactNumber.format(state.filtered.length)} matches`;
  elements.resultsHeadline.textContent = state.filtered.length
    ? `${compactNumber.format(state.filtered.length)} grants in view`
    : 'No grants match the current filters';

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Try a broader search or a different programme.';
    elements.resultsList.appendChild(empty);
    elements.loadMoreButton.hidden = true;
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const grant of visible) {
    const card = elements.grantCardTemplate.content.firstElementChild.cloneNode(true);
    const statusChip = card.querySelector('.status-chip');
    const id = card.querySelector('.grant-card__id');
    const link = card.querySelector('.grant-card__title a');
    const summary = card.querySelector('.grant-card__summary');
    const facts = card.querySelector('.grant-card__facts');

    statusChip.dataset.status = grant.status.id;
    statusChip.textContent = grant.status.label;
    id.textContent = grant.identifier;
    link.textContent = grant.title;
    link.href = grant.url;
    summary.textContent = grant.destination || grant.callTitle || grant.summary || 'No destination summary available.';

    facts.innerHTML = [
      createFact('Programme', getPrimaryProgramme(grant)),
      createFact('Opening', formatDate(grant.startDate || grant.plannedOpeningDate)),
      createFact('Deadline', formatDate(grant.deadlineDate)),
      createFact('Action', grant.actionType || grant.kind.label),
      createFact('Budget', formatCurrency(grant.budget?.totalBudgetEur)),
      createFact('Expected grants', grant.budget?.expectedGrants ? compactNumber.format(grant.budget.expectedGrants) : 'Unknown')
    ].join('');

    fragment.appendChild(card);
  }

  elements.resultsList.appendChild(fragment);
  elements.loadMoreButton.hidden = state.filtered.length <= state.visibleCount;
}

function syncControls() {
  elements.searchInput.value = state.filters.query;
  elements.programmeSelect.value = state.filters.programme;
  elements.sortSelect.value = state.filters.sort;
}

function update() {
  filterGrants();
  renderStatusPills();
  renderResults();
  writeHash();
}

async function loadData() {
  const response = await fetch(DATA_URL);
  if (!response.ok) {
    throw new Error(`Could not load data: ${response.status}`);
  }

  return response.json();
}

function wireEvents() {
  elements.searchInput.addEventListener('input', (event) => {
    state.filters.query = event.target.value;
    state.visibleCount = PAGE_STEP;
    update();
  });

  elements.programmeSelect.addEventListener('change', (event) => {
    state.filters.programme = event.target.value;
    state.visibleCount = PAGE_STEP;
    update();
  });

  elements.sortSelect.addEventListener('change', (event) => {
    state.filters.sort = event.target.value;
    update();
  });

  elements.resetButton.addEventListener('click', () => {
    state.filters = { query: '', status: 'live', programme: 'all', sort: 'start-desc' };
    state.visibleCount = PAGE_STEP;
    syncControls();
    update();
  });

  elements.loadMoreButton.addEventListener('click', () => {
    state.visibleCount += PAGE_STEP;
    renderResults();
  });

  window.addEventListener('hashchange', () => {
    parseHash();
    syncControls();
    update();
  });
}

async function init() {
  parseHash();
  state.data = await loadData();
  renderProgrammeOptions();
  renderMetrics();
  renderSidebar();
  syncControls();
  wireEvents();
  update();
}

init().catch((error) => {
  elements.resultsList.innerHTML = `<div class="empty-state">${error.message}</div>`;
  console.error(error);
});

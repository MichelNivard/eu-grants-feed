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
  topProgrammes: document.querySelector('#top-programmes'),
  grantCardTemplate: document.querySelector('#grant-card-template')
};

const compactNumber = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const moneyCompact = new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR', notation: 'compact', maximumFractionDigits: 1 });
const dateFormatter = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });

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

function formatCurrency(value) {
  if (!value) return 'Unknown';
  return moneyCompact.format(value);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return character;
    }
  });
}

function toggleProgrammeFilter(programmeId) {
  state.filters.programme = state.filters.programme === programmeId ? 'all' : programmeId;
  state.visibleCount = PAGE_STEP;
  syncControls();
  update();
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
  const now = Date.now();

  state.filtered = state.data.grants
    .filter((grant) => {
      if (grant.deadlineDate && new Date(grant.deadlineDate).getTime() < now) {
        return false;
      }

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
  const rawSourceCount =
    state.data.source?.storedResults
      ?? state.data.source?.totalResults
      ?? state.data.source?.reportedTotalResults
      ?? state.data.grants?.length
      ?? 0;
  const sourceCount = Number.isFinite(Number(rawSourceCount))
    ? Number(rawSourceCount)
    : (state.data.grants?.length || 0);

  elements.metricTotal.textContent = compactNumber.format(state.data.summary.total);
  elements.metricLive.textContent = compactNumber.format(openCount);
  elements.metricBudget.textContent = formatCurrency(state.data.summary.knownBudgetEur);
  elements.lastUpdated.textContent = formatDate(state.data.generatedAt);
  elements.sourceCount.textContent = `${compactNumber.format(sourceCount)} current calls from the official EU index`;
}

function renderSidebar() {
  elements.topProgrammes.innerHTML = '';

  const programmes = state.data.facets.frameworkProgramme.slice(0, 6);
  if (!programmes.length) {
    const empty = document.createElement('div');
    empty.className = 'mini-list__item';
    empty.textContent = 'No programme filters available.';
    elements.topProgrammes.appendChild(empty);
    return;
  }

  for (const programme of programmes) {
    const button = document.createElement('button');
    button.className = `mini-filter${state.filters.programme === programme.rawValue ? ' is-active' : ''}`;
    button.type = 'button';
    button.innerHTML = `
      <span class="mini-filter__title">${escapeHtml(programme.value)}</span>
      <span class="mini-filter__meta">${escapeHtml(compactNumber.format(programme.count))} calls</span>
    `;
    button.addEventListener('click', () => toggleProgrammeFilter(programme.rawValue));
    elements.topProgrammes.appendChild(button);
  }
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
    const titleButton = card.querySelector('.grant-card__title-button');
    const legacyTitleLink = card.querySelector('.grant-card__title a');
    const openLink = card.querySelector('.grant-card__open-link');
    const summary = card.querySelector('.grant-card__summary');
    const drawer = card.querySelector('.grant-card__drawer');
    const drawerSummary = card.querySelector('.grant-card__drawer-summary');
    const drawerAbstract = card.querySelector('.grant-card__drawer-abstract');
    const drawerAbstractBlock = card.querySelector('.grant-card__drawer-block--abstract');
    const facts = card.querySelector('.grant-card__facts');

    statusChip.dataset.status = grant.status.id;
    statusChip.textContent = grant.status.label;
    id.textContent = grant.identifier;
    if (titleButton) {
      titleButton.textContent = grant.title;
      titleButton.setAttribute('aria-expanded', 'false');
    }
    if (legacyTitleLink) {
      legacyTitleLink.textContent = grant.title;
      legacyTitleLink.href = grant.url;
    }
    if (openLink) {
      openLink.href = grant.url;
    }
    summary.textContent = grant.destination || grant.callTitle || grant.summary || 'No destination summary available.';
    if (drawerSummary) {
      drawerSummary.textContent = grant.destination || grant.callTitle || grant.summary || 'No short summary was exposed for this call.';
    }

    if (grant.abstract && drawerAbstract && drawerAbstractBlock) {
      drawerAbstract.textContent = grant.abstract;
      drawerAbstractBlock.hidden = false;
    } else if (drawerAbstract && drawerAbstractBlock) {
      drawerAbstract.textContent = '';
      drawerAbstractBlock.hidden = true;
    }

    if (titleButton && drawer) {
      titleButton.addEventListener('click', () => {
        const isOpen = !drawer.hidden;
        drawer.hidden = isOpen;
        card.classList.toggle('is-expanded', !isOpen);
        titleButton.setAttribute('aria-expanded', String(!isOpen));
      });
    }

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
  renderSidebar();
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
  syncControls();
  wireEvents();
  update();
}

init().catch((error) => {
  elements.resultsList.innerHTML = `<div class="empty-state">${error.message}</div>`;
  console.error(error);
});

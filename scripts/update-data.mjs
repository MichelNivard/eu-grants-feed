import { mkdir, writeFile } from 'node:fs/promises';

const PORTAL_CONFIG_URL = 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/assets/openid-login-config.json';
const OUTPUT_DIR = new URL('../data/', import.meta.url);
const OUTPUT_FILE = new URL('../data/grants.json', import.meta.url);
const PAGE_SIZE = 100;
const SEARCH_TEXT = '***';
const MAX_API_WINDOW = 10000;
const SPLIT_FIELDS = ['frameworkProgramme', 'programmeDivision'];
const DISPLAY_FIELDS = [
  'identifier',
  'title',
  'startDate',
  'deadlineDate',
  'status',
  'type',
  'callIdentifier',
  'callTitle',
  'frameworkProgramme',
  'programmeDivision',
  'typesOfAction',
  'budgetOverview',
  'actions',
  'url',
  'destinationDescription',
  'descriptionByte',
  'summary'
];

const BASE_FILTERS = {
  type: ['1', '2', '8'],
  status: ['31094501', '31094502']
};

const STATUS_FALLBACKS = {
  '31094501': 'Forthcoming',
  '31094502': 'Open for submission',
  '31094503': 'Closed'
};

const TYPE_FALLBACKS = {
  '1': 'Grant',
  '2': 'Calls for proposals',
  '8': 'Cascade funding calls'
};

function first(values) {
  return Array.isArray(values) && values.length ? values[0] : null;
}

function all(values) {
  return Array.isArray(values) ? values : [];
}

function parseJson(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function decodeHtmlEntities(value) {
  if (!value) {
    return '';
  }

  const namedEntities = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&nbsp;': ' '
  };

  return value
    .replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (entity) => namedEntities[entity] || entity)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function htmlToText(value) {
  if (!value) {
    return null;
  }

  const text = decodeHtmlEntities(
    value
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|ul|ol|h[1-6])>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();

  return text || null;
}

function excerptText(value, maxLength = 1100) {
  if (!value) {
    return null;
  }

  if (value.length <= maxLength) {
    return value;
  }

  const slice = value.slice(0, maxLength);
  const sentenceBreak = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  const wordBreak = slice.lastIndexOf(' ');
  const cutoff = sentenceBreak > maxLength * 0.55 ? sentenceBreak + 1 : wordBreak;
  return `${slice.slice(0, cutoff > 0 ? cutoff : maxLength).trim()}…`;
}

function toIsoDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getRefreshMetadata() {
  const refreshedAt = toIsoDate(process.env.GRANTS_REFRESHED_AT) || new Date().toISOString();
  const workflowName = process.env.GRANTS_REFRESH_WORKFLOW || null;
  const eventName = process.env.GRANTS_REFRESH_EVENT || null;
  const runUrl = process.env.GRANTS_REFRESH_RUN_URL || null;

  return {
    refreshedAt,
    workflowName,
    eventName,
    runUrl
  };
}

function uniqueObjects(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.id}:${item.label}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function makeLookup(values) {
  return Object.fromEntries((values || []).map((item) => [item.rawValue, item.value]));
}

function buildFacetLookups(facets) {
  return {
    frameworkProgramme: makeLookup(facets.frameworkProgramme),
    programmeDivision: makeLookup(facets.programmeDivision),
    status: makeLookup(facets.status),
    type: makeLookup(facets.type)
  };
}

function buildSearchQuery(filters) {
  const must = [];

  for (const [field, value] of Object.entries(filters)) {
    if (!value || (Array.isArray(value) && !value.length)) {
      continue;
    }

    if (field === 'startDate' || field === 'deadlineDate') {
      const ranges = [];
      if (value.gte) {
        ranges.push({ range: { [field]: { gte: value.gte } } });
      }
      if (value.lte) {
        ranges.push({ range: { [field]: { lte: value.lte } } });
      }
      must.push(...ranges);
      continue;
    }

    must.push({ terms: { [field]: Array.isArray(value) ? value : [value] } });
  }

  return { bool: { must } };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}

async function postMultipart(url, body) {
  const formData = new FormData();

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (Array.isArray(value) || typeof value === 'object') {
      formData.append(key, new Blob([JSON.stringify(value)], { type: 'application/json' }));
    } else {
      formData.append(key, value);
    }
  }

  const response = await fetch(url, {
    method: 'POST',
    body: formData,
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} for ${url}`);
  }

  return response.json();
}

async function fetchPortalConfig() {
  const config = await fetchJson(PORTAL_CONFIG_URL);
  const sedia = config?.modules?.sedia;

  if (!sedia?.corporateSearchUrl || !sedia?.facetUrl || !sedia?.corporateSearchApiKey) {
    throw new Error('Portal config is missing search settings.');
  }

  return {
    searchUrl: sedia.corporateSearchUrl + sedia.corporateSearchApiKey,
    facetUrl: sedia.facetUrl + sedia.corporateSearchApiKey
  };
}

async function fetchFacets(facetUrl, query) {
  const payload = await postMultipart(`${facetUrl}&text=${encodeURIComponent(SEARCH_TEXT)}`, {
    query,
    languages: ['en'],
    displayLanguage: 'en'
  });

  const facets = Object.fromEntries((payload.facets || []).map((facet) => [facet.name, facet.values || []]));
  return {
    frameworkProgramme: facets.frameworkProgramme || [],
    programmeDivision: facets.programmeDivision || [],
    status: facets.status || [],
    type: facets.type || []
  };
}

async function fetchSearchPage(searchUrl, query, pageNumber) {
  return postMultipart(`${searchUrl}&text=${encodeURIComponent(SEARCH_TEXT)}&pageSize=${PAGE_SIZE}&pageNumber=${pageNumber}`, {
    sort: { order: 'DESC', field: 'startDate' },
    query,
    languages: ['en'],
    displayFields: DISPLAY_FIELDS
  });
}

async function fetchResultWindow(searchUrl, query, label) {
  const firstPage = await fetchSearchPage(searchUrl, query, 1);
  const totalPages = Math.ceil(firstPage.totalResults / PAGE_SIZE);
  const results = [...(firstPage.results || [])];
  const concurrency = 5;

  for (let start = 2; start <= totalPages; start += concurrency) {
    const batch = [];
    const end = Math.min(totalPages, start + concurrency - 1);

    for (let page = start; page <= end; page += 1) {
      batch.push(fetchSearchPage(searchUrl, query, page));
    }

    const pages = await Promise.all(batch);
    for (const page of pages) {
      results.push(...(page.results || []));
    }

    console.log(`Fetched ${label} pages ${start}-${end} of ${totalPages}`);
  }

  return {
    totalResults: firstPage.totalResults,
    results
  };
}

function dedupeResults(results) {
  const seen = new Set();
  const unique = [];

  for (const result of results) {
    if (seen.has(result.reference)) {
      continue;
    }
    seen.add(result.reference);
    unique.push(result);
  }

  return unique;
}

async function fetchPartitionedResults(searchUrl, facetUrl, filters = BASE_FILTERS, depth = 0) {
  const query = buildSearchQuery(filters);
  const preview = await fetchSearchPage(searchUrl, query, 1);
  const label = JSON.stringify(filters);

  if (preview.totalResults <= MAX_API_WINDOW) {
    return fetchResultWindow(searchUrl, query, label);
  }

  if (depth >= SPLIT_FIELDS.length) {
    throw new Error(`Could not partition oversized query: ${label}`);
  }

  const facets = await fetchFacets(facetUrl, query);
  const splitField = SPLIT_FIELDS[depth];
  const splitValues = facets[splitField].filter((value) => value.count > 0);

  if (splitValues.length < 2) {
    return fetchPartitionedResults(searchUrl, facetUrl, filters, depth + 1);
  }

  console.log(`Splitting oversized query by ${splitField}: ${preview.totalResults} results`);

  const nestedResults = [];
  for (const value of splitValues) {
    const nestedFilters = {
      ...filters,
      [splitField]: [value.rawValue]
    };
    const nested = await fetchPartitionedResults(searchUrl, facetUrl, nestedFilters, depth + 1);
    nestedResults.push(...nested.results);
  }

  return {
    totalResults: preview.totalResults,
    results: dedupeResults(nestedResults)
  };
}

function extractBudget(identifier, rawBudgetOverview) {
  const parsed = parseJson(rawBudgetOverview);
  const topicActionMap = parsed?.budgetTopicActionMap;
  if (!topicActionMap || !identifier) {
    return null;
  }

  const matches = [];
  for (const actions of Object.values(topicActionMap)) {
    for (const action of actions || []) {
      if (typeof action?.action === 'string' && action.action.includes(identifier)) {
        matches.push(action);
      }
    }
  }

  if (!matches.length) {
    return null;
  }

  const totalBudgetEur = matches.reduce((sum, action) => {
    const yearBudget = Object.values(action.budgetYearMap || {}).reduce((inner, value) => inner + (toNumber(value) || 0), 0);
    return sum + yearBudget;
  }, 0);

  const minValues = matches.map((action) => toNumber(action.minContribution)).filter(Boolean);
  const maxValues = matches.map((action) => toNumber(action.maxContribution)).filter(Boolean);

  return {
    totalBudgetEur: totalBudgetEur || null,
    expectedGrants: matches.reduce((sum, action) => sum + (toNumber(action.expectedGrants) || 0), 0) || null,
    minContributionEur: minValues.length ? Math.min(...minValues) : null,
    maxContributionEur: maxValues.length ? Math.max(...maxValues) : null,
    years: parsed.budgetYearsColumns || []
  };
}

function extractAction(rawActions) {
  const parsed = parseJson(rawActions);
  const firstAction = Array.isArray(parsed) && parsed.length ? parsed[0] : null;
  if (!firstAction) {
    return null;
  }

  return {
    statusId: firstAction.status?.id ? String(firstAction.status.id) : null,
    statusLabel: firstAction.status?.description || null,
    plannedOpeningDate: toIsoDate(firstAction.plannedOpeningDate),
    deadlineModel: firstAction.deadlineModel || null,
    deadlineDates: (firstAction.deadlineDates || []).map((value) => toIsoDate(value))
  };
}

function labelizeIds(ids, lookup) {
  return uniqueObjects(
    ids.map((id) => ({
      id,
      label: lookup[id] || id
    }))
  );
}

function normalizeResult(result, lookups) {
  const metadata = result.metadata || {};
  const identifier = first(metadata.identifier);
  const action = extractAction(first(metadata.actions));
  const budget = extractBudget(identifier, first(metadata.budgetOverview));
  const abstractText = excerptText(htmlToText(first(metadata.descriptionByte)));
  const statusId = first(metadata.status) || action?.statusId || null;
  const typeId = first(metadata.type) || null;
  const frameworkProgrammeIds = all(metadata.frameworkProgramme);
  const programmeDivisionIds = all(metadata.programmeDivision);
  const destination = first(metadata.destinationDescription);
  const summary = result.summary || destination || '';

  return {
    id: result.reference,
    identifier,
    title: first(metadata.title) || result.summary || result.content || identifier,
    summary,
    url: first(metadata.url) || result.url,
    callIdentifier: first(metadata.callIdentifier),
    callTitle: first(metadata.callTitle),
    destination,
    abstract: abstractText,
    actionType: first(metadata.typesOfAction),
    status: {
      id: statusId,
      label: lookups.status[statusId] || action?.statusLabel || STATUS_FALLBACKS[statusId] || statusId
    },
    kind: {
      id: typeId,
      label: lookups.type[typeId] || TYPE_FALLBACKS[typeId] || typeId
    },
    startDate: toIsoDate(first(metadata.startDate)),
    deadlineDate: toIsoDate(first(metadata.deadlineDate)) || action?.deadlineDates?.[0] || null,
    plannedOpeningDate: action?.plannedOpeningDate || null,
    deadlineModel: action?.deadlineModel || null,
    frameworkProgrammes: labelizeIds(frameworkProgrammeIds, lookups.frameworkProgramme),
    programmeDivisions: labelizeIds(programmeDivisionIds, lookups.programmeDivision),
    budget,
    searchText: [
      identifier,
      first(metadata.title),
      summary,
      first(metadata.callIdentifier),
      first(metadata.callTitle),
      destination,
      first(metadata.typesOfAction),
      abstractText
    ].filter(Boolean).join(' ')
  };
}

function buildSummary(grants) {
  const byStatus = grants.reduce((accumulator, grant) => {
    const key = grant.status.id;
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {});

  const knownBudgetEur = grants.reduce((sum, grant) => sum + (grant.budget?.totalBudgetEur || 0), 0);
  const closingSoonCutoff = Date.now() + 1000 * 60 * 60 * 24 * 30;
  const closingSoon = grants.filter((grant) => grant.deadlineDate && new Date(grant.deadlineDate).getTime() <= closingSoonCutoff && grant.status.id === '31094502').length;

  return {
    total: grants.length,
    byStatus,
    closingSoon,
    knownBudgetEur: knownBudgetEur || null
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const now = Date.now();
  const refresh = getRefreshMetadata();

  const endpoints = await fetchPortalConfig();
  console.log('Using official endpoints from portal config.');

  const baseQuery = buildSearchQuery(BASE_FILTERS);
  const [facets, search] = await Promise.all([
    fetchFacets(endpoints.facetUrl, baseQuery),
    fetchPartitionedResults(endpoints.searchUrl, endpoints.facetUrl)
  ]);

  const lookups = buildFacetLookups(facets);
  const grants = dedupeResults(search.results)
    .map((result) => normalizeResult(result, lookups))
    .filter((grant) => !grant.deadlineDate || new Date(grant.deadlineDate).getTime() >= now)
    .sort((left, right) => {
      const leftDate = left.startDate ? new Date(left.startDate).getTime() : 0;
      const rightDate = right.startDate ? new Date(right.startDate).getTime() : 0;
      return rightDate - leftDate;
    });

  const output = {
    generatedAt: refresh.refreshedAt,
    source: {
      config: PORTAL_CONFIG_URL,
      searchUrl: endpoints.searchUrl,
      facetUrl: endpoints.facetUrl,
      reportedTotalResults: search.totalResults,
      storedResults: grants.length,
      workflow: refresh
    },
    facets,
    summary: buildSummary(grants),
    grants
  };

  await writeFile(OUTPUT_FILE, JSON.stringify(output));
  console.log(`Wrote ${grants.length} grants to ${OUTPUT_FILE.pathname}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_STRAPI_BASE_URL = 'https://cms.develop.99iddev.net';
const PRODUCTION_STRAPI_BASE_URL = 'https://cms.rumah123.com';
const OFFICE_VENUE_UID = 'api::office-venue.office-venue';
const DEFAULT_CONTENT_FIELD = 'image';
const DEFAULT_COMPONENT_SOURCE = 'Rumah123';
const DEFAULT_COMPONENT_TYPE = 'Top Preview';
const DEFAULT_COMPONENT_SUB_TYPE = 'Fasad Gedung';
const SUB_TYPE_BY_CATEGORY = new Map([
  ['interior', 'Foto Lainnya'],
  ['exterior', 'Fasad Gedung'],
  ['floorplan', 'Denah Ruang'],
]);

async function main() {
  const options = parseOptions(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  if (!options.token) {
    throw new Error('STRAPI_ADMIN_JWT or --token is required');
  }
  if (!options.confirm && !options.dryRun) {
    throw new Error('Use --confirm to update Strapi, or --dry-run to preview.');
  }

  await confirmProductionAccess(options);

  if (!options.reportPath) {
    options.reportPath = await findLatestReport(options.reportDir);
  }

  const csvPath = getCsvReportPath(options.reportPath);
  const markdownPath = getMarkdownReportPath(options.reportPath);
  const rows = parseCsv(await fs.readFile(csvPath, 'utf8'));
  const assets = filterAssetsByOffice(getSuccessfulAssets(rows), options.officeFilters);

  if (assets.length === 0) {
    throw new Error(`No uploaded/skipped Strapi asset IDs found in ${csvPath}${options.officeFilters.length ? ` for office filter(s): ${options.officeFilters.join(', ')}` : ''}`);
  }

  const client = createClient(options);
  const resolved = options.officeVenueId
    ? { venueGroups: [{ officeName: `office-venue-${options.officeVenueId}`, assets, entry: await getOfficeVenueEntry(client, options.officeVenueId) }], skippedGroups: [] }
    : await resolveVenueGroups(client, assets, options.matchField);
  const { venueGroups, skippedGroups } = resolved;
  const results = [];

  for (const venueGroup of venueGroups) {
    results.push(await linkVenueGroup({ client, options, venueGroup }));
  }

  const totalLinked = results.reduce((sum, result) => sum + result.linkedAssets.length, 0);
  const totalMissing = results.reduce((sum, result) => sum + result.missingAfterUpdate.length, 0);

  console.log(`Venue entries: ${venueGroups.length}`);
  console.log(`Unmatched venue groups: ${skippedGroups.length}`);
  console.log(`Verified linked: ${totalLinked}`);
  if (totalMissing > 0) {
    console.log(`Missing after verification: ${totalMissing}`);
  }

  if (!options.noReport) {
    await appendMarkdownRelationReport(markdownPath, {
      options,
      csvPath,
      assets,
      results,
      skippedGroups,
    });
  }

  if (!options.dryRun && totalMissing > 0) {
    process.exitCode = 1;
  }
}

async function linkVenueGroup({ client, options, venueGroup }) {
  const entryId = getEntityId(venueGroup.entry);
  if (!entryId) {
    throw new Error(`Office Venue entry for ${venueGroup.officeName} is missing an id.`);
  }

  const beforeEntry = await getOfficeVenueEntry(client, entryId);
  venueGroup.entry = beforeEntry;
  const existingComponents = normalizeComponentList(getEntryField(beforeEntry, options.contentField));
  const existingAssetIds = new Set(existingComponents.flatMap(getComponentImageUrlIds));
  const missingAssets = venueGroup.assets.filter((asset) => !existingAssetIds.has(asset.id));
  const payloadComponents = [
    ...existingComponents.map(normalizeExistingImageComponent),
    ...missingAssets.map((asset) => buildNewImageComponent(options, asset)),
  ];

  console.log(`\nOffice Venue ${beforeEntry.id} (${venueGroup.officeName})`);
  console.log(`Field: ${options.contentField}`);
  console.log(`Report assets: ${venueGroup.assets.length}`);
  console.log(`Existing imageUrl media IDs: ${[...existingAssetIds].sort((a, b) => a - b).join(', ') || 'none'}`);
  console.log(`Already linked: ${venueGroup.assets.length - missingAssets.length}`);
  console.log(`To append: ${missingAssets.length}`);
  for (const asset of missingAssets) {
    console.log(`- append ${asset.filename} as ${asset.subType} (${asset.category})`);
  }

  let afterEntry = beforeEntry;
  let didUpdate = false;
  if (!options.dryRun && missingAssets.length > 0) {
    await updateOfficeVenueImages(client, beforeEntry.id, options.contentField, payloadComponents);
    afterEntry = await getOfficeVenueEntry(client, beforeEntry.id);
    didUpdate = true;
  } else if (missingAssets.length === 0) {
    console.log('No missing assets; skipping Strapi update.');
  }

  const afterComponents = normalizeComponentList(getEntryField(afterEntry, options.contentField));
  const afterAssetIds = new Set(afterComponents.flatMap(getComponentImageUrlIds));
  const linkedAssets = venueGroup.assets.filter((asset) => afterAssetIds.has(asset.id));
  const missingAfterUpdate = venueGroup.assets.filter((asset) => !afterAssetIds.has(asset.id));

  console.log(`Verified linked: ${linkedAssets.length}`);
  if (missingAfterUpdate.length > 0) {
    console.log(`Missing after verification: ${missingAfterUpdate.length}`);
  }

  return { venueGroup, entry: beforeEntry, missingAssets, linkedAssets, missingAfterUpdate, didUpdate };
}

function parseOptions(argv) {
  const parsed = parseArgv(argv);
  const reportPath = getValue(parsed, 'report') || process.env.STRAPI_UPLOAD_REPORT || '';
  const baseUrl = normalizeBaseUrl(getValue(parsed, 'base-url') || process.env.STRAPI_BASE_URL || DEFAULT_STRAPI_BASE_URL);
  const officeFilters = getValues(parsed, 'office')
    .concat(process.env.STRAPI_OFFICE ? [process.env.STRAPI_OFFICE] : [])
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    help: hasFlag(parsed, 'help') || hasFlag(parsed, 'h'),
    reportPath,
    reportDir: path.resolve(getValue(parsed, 'report-dir') || process.env.STRAPI_REPORT_DIR || 'logs/strapi-upload-reports'),
    baseUrl,
    token: getValue(parsed, 'token') || process.env.STRAPI_ADMIN_JWT || '',
    officeVenueId: getValue(parsed, 'office-venue-id') || process.env.STRAPI_OFFICE_VENUE_ID || '',
    officeFilters,
    matchField: getValue(parsed, 'match-field') || process.env.STRAPI_OFFICE_VENUE_MATCH_FIELD || 'slug',
    contentField: getValue(parsed, 'content-field') || process.env.STRAPI_OFFICE_VENUE_IMAGE_FIELD || DEFAULT_CONTENT_FIELD,
    source: getValue(parsed, 'source') || process.env.STRAPI_OFFICE_VENUE_IMAGE_SOURCE || DEFAULT_COMPONENT_SOURCE,
    type: getValue(parsed, 'type') || process.env.STRAPI_OFFICE_VENUE_IMAGE_TYPE || DEFAULT_COMPONENT_TYPE,
    subType: getValue(parsed, 'sub-type') || process.env.STRAPI_OFFICE_VENUE_IMAGE_SUB_TYPE || DEFAULT_COMPONENT_SUB_TYPE,
    confirm: hasFlag(parsed, 'confirm'),
    dryRun: hasFlag(parsed, 'dry-run'),
    noReport: hasFlag(parsed, 'no-report'),
    confirmProduction: hasFlag(parsed, 'confirm-production') || process.env.STRAPI_CONFIRM_PRODUCTION === '1',
  };
}

function parseArgv(argv) {
  const values = new Map();
  const flags = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const key = arg.slice(2);
    const equalsIndex = key.indexOf('=');
    if (equalsIndex !== -1) {
      addValue(values, key.slice(0, equalsIndex), key.slice(equalsIndex + 1));
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      addValue(values, key, next);
      index += 1;
    } else {
      flags.add(key);
    }
  }

  return { values, flags };
}

function addValue(values, key, value) {
  if (!values.has(key)) {
    values.set(key, []);
  }
  values.get(key).push(value);
}

function getValue(parsed, key) {
  const values = parsed.values.get(key);
  return values && values.length > 0 ? values[values.length - 1] : undefined;
}

function getValues(parsed, key) {
  return parsed.values.get(key) || [];
}

function hasFlag(parsed, key) {
  return parsed.flags.has(key);
}

async function confirmProductionAccess(options) {
  if (!isProductionBaseUrl(options.baseUrl) || options.confirmProduction) {
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Refusing to access production ${PRODUCTION_STRAPI_BASE_URL} without confirmation. Re-run interactively or pass --confirm-production / STRAPI_CONFIRM_PRODUCTION=1.`);
  }

  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log(`\nProduction Strapi target detected: ${PRODUCTION_STRAPI_BASE_URL}`);
    const answer = await rl.question('Type "production" to continue, or anything else to abort: ');
    if (answer.trim() !== 'production') {
      throw new Error('Production content update aborted.');
    }
  } finally {
    rl.close();
  }
}

function isProductionBaseUrl(baseUrl) {
  return normalizeBaseUrl(baseUrl) === PRODUCTION_STRAPI_BASE_URL;
}

function createClient(options) {
  return {
    baseUrl: options.baseUrl,
    token: options.token,
  };
}

async function getOfficeVenueEntry(client, id) {
  const body = await requestJson(client, `/content-manager/collection-types/${encodeURIComponent(OFFICE_VENUE_UID)}/${encodeURIComponent(id)}`);
  return unwrapEntry(body);
}

async function findOfficeVenueEntry(client, field, value) {
  const body = await requestJson(client, `/content-manager/collection-types/${encodeURIComponent(OFFICE_VENUE_UID)}`, {
    params: {
      page: 1,
      pageSize: 2,
      [`filters[$and][0][${field}][$eq]`]: value,
    },
  });
  const entries = unwrapEntries(body);
  if (entries.length > 1) {
    throw new Error(`Multiple Office Venue entries matched ${field}=${value}`);
  }
  return entries[0] || null;
}

async function updateOfficeVenueImages(client, id, field, components) {
  return requestJson(client, `/content-manager/collection-types/${encodeURIComponent(OFFICE_VENUE_UID)}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [field]: components }),
  });
}

async function requestJson(client, pathname, options = {}) {
  const url = new URL(pathname, `${client.baseUrl}/`);
  for (const [key, value] of Object.entries(options.params || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.append(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${client.token}`,
      ...(options.headers || {}),
    },
    body: options.body,
  });

  const text = await response.text();
  const body = parseJsonResponse(text);

  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${url.pathname} failed: HTTP ${response.status}${body ? ` ${JSON.stringify(body)}` : ''}`);
  }

  return body;
}

function parseJsonResponse(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function unwrapEntry(body) {
  if (body?.data?.attributes) {
    return { id: body.data.id, ...body.data.attributes };
  }
  if (body?.data && typeof body.data === 'object') {
    return body.data;
  }
  return body;
}

function unwrapEntries(body) {
  const list = Array.isArray(body?.results) ? body.results : Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  return list.map(unwrapEntry);
}

async function resolveVenueGroups(client, assets, matchField) {
  const assetsByOffice = groupAssetsByOffice(assets);
  const venueGroups = [];
  const skippedGroups = [];

  for (const [officeName, officeAssets] of assetsByOffice.entries()) {
    const entry = await findOfficeVenueEntry(client, matchField, officeName);
    if (!entry) {
      console.log(`- no Office Venue match for ${matchField}=${officeName}; skipping ${officeAssets.length} asset(s)`);
      skippedGroups.push({ officeName, assets: officeAssets, skippedReason: 'not_found' });
      continue;
    }

    venueGroups.push({ officeName, assets: officeAssets, entry });
  }

  return { venueGroups, skippedGroups };
}

function groupAssetsByOffice(assets) {
  const groups = new Map();
  for (const asset of assets) {
    const key = asset.officeName || '';
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(asset);
  }
  return groups;
}

function getEntryField(entry, field) {
  return entry?.[field] || entry?.attributes?.[field] || [];
}

function normalizeComponentList(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(value?.data)) {
    return value.data.map((item) => ({ id: item.id, ...(item.attributes || item) }));
  }
  return [];
}

function normalizeExistingImageComponent(component) {
  const normalized = {
    ...(component.id ? { id: component.id } : {}),
    source: component.source || DEFAULT_COMPONENT_SOURCE,
    type: component.type || DEFAULT_COMPONENT_TYPE,
    subType: component.subType || component.sub_type || DEFAULT_COMPONENT_SUB_TYPE,
  };

  if (component.imageUrl === null || component.imageUrl === undefined) {
    return { ...normalized, imageUrl: component.imageUrl ?? null };
  }

  return {
    ...normalized,
    imageUrl: getMediaIds(component.imageUrl),
  };
}

function buildNewImageComponent(options, asset) {
  return {
    imageUrl: [asset.id],
    source: options.source,
    type: options.type,
    subType: asset.subType || options.subType,
  };
}

function getMediaIds(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(getMediaIds).filter(Boolean);
  }
  if (Array.isArray(value.data)) {
    return value.data.flatMap(getMediaIds).filter(Boolean);
  }
  if (value.data) {
    return getMediaIds(value.data);
  }
  if (value.attributes) {
    return getMediaIds({ id: value.id, ...value.attributes });
  }
  const id = getEntityId(value);
  return id ? [id] : [];
}

function getComponentImageUrlIds(component) {
  return getMediaIds(component?.imageUrl);
}

function getEntityId(value) {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  if (value?.id) {
    return Number(value.id);
  }
  if (value?.documentId && /^\d+$/.test(String(value.documentId))) {
    return Number(value.documentId);
  }
  return null;
}

function getSuccessfulAssets(rows) {
  const done = new Set(['uploaded', 'skipped_existing']);
  const assetsById = new Map();

  for (const row of rows) {
    if (!done.has(row.status)) {
      continue;
    }

    const id = getEntityId(row.strapi_asset_id);
    if (!id || assetsById.has(id)) {
      continue;
    }

    assetsById.set(id, {
      id,
      filename: row.filename || '',
      assetName: row.strapi_asset_name || '',
      url: row.strapi_url || '',
      officeName: row.office_name || '',
      folder: row.media_library_folder || '',
      category: getAssetCategory(row),
      subType: getAssetSubType(row),
      status: row.status || '',
    });
  }

  return [...assetsById.values()];
}

function getAssetSubType(row) {
  return SUB_TYPE_BY_CATEGORY.get(getAssetCategory(row)) || DEFAULT_COMPONENT_SUB_TYPE;
}

function getAssetCategory(row) {
  const values = [
    row.local_category,
    row.category,
    row.relative_path,
    row.local_path,
    row.source_path,
    row.filename,
  ].filter(Boolean);

  for (const value of values) {
    const category = detectCategory(value);
    if (category) {
      return category;
    }
  }

  return 'exterior';
}

function detectCategory(value) {
  const normalized = String(value).toLowerCase();
  if (/(^|[\\/_-])floor[\s_-]*plan([\\/_\-.]|$)|(^|[\\/_-])floorplan([\\/_\-.]|$)/.test(normalized)) {
    return 'floorplan';
  }
  if (/(^|[\\/_-])interior([\\/_\-.]|$)/.test(normalized)) {
    return 'interior';
  }
  if (/(^|[\\/_-])exterior([\\/_\-.]|$)/.test(normalized)) {
    return 'exterior';
  }
  return '';
}

function filterAssetsByOffice(assets, officeFilters) {
  if (officeFilters.length === 0) {
    return assets;
  }

  const filters = new Set(officeFilters.map(normalizeKey));
  return assets.filter((asset) => filters.has(normalizeKey(asset.officeName)));
}

function parseCsv(text) {
  const parsedRows = [];
  let row = [];
  let cell = '';
  let quote = false;

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    const next = text[index + 1];

    if (quote && ch === '"' && next === '"') {
      cell += '"';
      index += 1;
    } else if (ch === '"') {
      quote = !quote;
    } else if (!quote && ch === ',') {
      row.push(cell);
      cell = '';
    } else if (!quote && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && next === '\n') {
        index += 1;
      }
      row.push(cell);
      if (row.some(Boolean)) {
        parsedRows.push(row);
      }
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    parsedRows.push(row);
  }

  const header = parsedRows.shift() || [];
  return parsedRows.map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index] || ''])));
}

async function appendMarkdownRelationReport(markdownPath, result) {
  const { options, csvPath, assets, results, skippedGroups } = result;
  const linkedIds = new Set(results.flatMap((item) => item.linkedAssets.map((asset) => asset.id)));
  const appendedIds = new Set(results.flatMap((item) => item.missingAssets.map((asset) => asset.id)));
  const missingAfterUpdate = results.flatMap((item) => item.missingAfterUpdate);
  const contentEntries = results.map((item) => item.entry);
  const lines = [];

  lines.push('');
  lines.push('## Strapi Content Relation');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Source CSV: ${csvPath}`);
  lines.push(`Content match field: ${options.officeVenueId ? 'id' : options.matchField}`);
  lines.push(`Field: ${options.contentField}`);
  lines.push(`Component: office-venue-image.image`);
  lines.push(`Component defaults: source=${options.source}, type=${options.type}, fallback subType=${options.subType}`);
  lines.push('subType mapping: interior=Foto Lainnya, exterior=Fasad Gedung, floorplan=Denah Ruang');
  lines.push(`Mode: ${options.dryRun ? 'dry-run' : 'update'}`);
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('| --- | ---: |');
  lines.push(`| Report assets | ${assets.length} |`);
  lines.push(`| Matched content entries | ${contentEntries.length} |`);
  lines.push(`| Unmatched venue groups | ${skippedGroups.length} |`);
  lines.push(`| Newly appended | ${appendedIds.size} |`);
  lines.push(`| Verified linked | ${linkedIds.size} |`);
  lines.push(`| Missing after verification | ${missingAfterUpdate.length} |`);
  lines.push('');
  lines.push('| Office | Content ID | Content URL | Asset ID | Filename | Category | subType | Folder | Strapi URL | Relation Status |');
  lines.push('| --- | ---: | --- | ---: | --- | --- | --- | --- | --- | --- |');

  for (const item of results) {
    const contentUrl = `${options.baseUrl}/admin/content-manager/collectionType/${OFFICE_VENUE_UID}/${item.entry.id}`;
    for (const asset of item.venueGroup.assets) {
      const status = linkedIds.has(asset.id)
        ? appendedIds.has(asset.id) ? 'linked_appended' : 'linked_existing'
        : 'missing';
      lines.push(`| ${escapeMarkdownCell(item.venueGroup.officeName)} | ${item.entry.id} | ${contentUrl} | ${asset.id} | ${escapeMarkdownCell(asset.filename)} | ${escapeMarkdownCell(asset.category)} | ${escapeMarkdownCell(asset.subType)} | ${escapeMarkdownCell(asset.folder)} | ${escapeMarkdownCell(asset.url)} | ${status} |`);
    }
  }

  for (const group of skippedGroups) {
    for (const asset of group.assets) {
      lines.push(`| ${escapeMarkdownCell(group.officeName)} |  |  | ${asset.id} | ${escapeMarkdownCell(asset.filename)} | ${escapeMarkdownCell(asset.category)} | ${escapeMarkdownCell(asset.subType)} | ${escapeMarkdownCell(asset.folder)} | ${escapeMarkdownCell(asset.url)} | content_not_found |`);
    }
  }

  await fs.appendFile(markdownPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Updated Markdown report: ${markdownPath}`);
}

function getCsvReportPath(reportPath) {
  if (reportPath.endsWith('.csv')) {
    return reportPath;
  }
  if (reportPath.endsWith('.md')) {
    return reportPath.replace(/\.md$/i, '.csv');
  }
  return reportPath;
}

function getMarkdownReportPath(reportPath) {
  if (reportPath.endsWith('.md')) {
    return reportPath;
  }
  if (reportPath.endsWith('.csv')) {
    return reportPath.replace(/\.csv$/i, '.md');
  }
  return `${reportPath}.md`;
}

async function findLatestReport(reportDir) {
  let entries;
  try {
    entries = await fs.readdir(reportDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Report directory not found: ${reportDir}`);
    }
    throw error;
  }

  const reports = entries
    .filter((entry) => entry.isFile() && /^strapi-upload-report-.*\.csv$/.test(entry.name))
    .map((entry) => path.join(reportDir, entry.name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

  const latest = reports.at(-1);
  if (!latest) {
    throw new Error(`No strapi-upload-report-*.csv files found in ${reportDir}`);
  }

  console.log(`Using latest upload report: ${latest}`);
  return latest;
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '').replace(/\/admin$/, '');
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function escapeMarkdownCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function printHelp() {
  console.log(`Usage:
  node link-strapi-office-venue-images.mjs [options]

Required:
  --confirm                    Actually update Strapi. Use --dry-run to preview.

Common options:
  --report <path>              Strapi upload report CSV or Markdown path. Defaults to latest CSV in report dir.
  --report-dir <path>          Report directory. Defaults to logs/strapi-upload-reports.
  --base-url <url>             Strapi base URL. Defaults to ${DEFAULT_STRAPI_BASE_URL}.
  --token <jwt>                Strapi admin JWT. Prefer STRAPI_ADMIN_JWT env var.
  --office <slug>              Link only one office slug, e.g. graha-cimb-niaga.
  --match-field <field>        Office Venue field matched to report office_name. Defaults to slug.
  --office-venue-id <id>       Optional override: link all report assets to one Office Venue id.
  --content-field <field>      Office Venue component field. Defaults to ${DEFAULT_CONTENT_FIELD}.
  --source <value>             Component source. Defaults to ${DEFAULT_COMPONENT_SOURCE}.
  --type <value>               Component type. Defaults to ${DEFAULT_COMPONENT_TYPE}.
  --sub-type <value>           Component subType. Defaults to ${DEFAULT_COMPONENT_SUB_TYPE}.
  --confirm-production         Allow access when STRAPI_BASE_URL is ${PRODUCTION_STRAPI_BASE_URL}.
  --no-report                  Do not append verification details to the Markdown report.

Environment variables:
  STRAPI_BASE_URL=${DEFAULT_STRAPI_BASE_URL}
  STRAPI_ADMIN_JWT=<admin-jwt-from-browser-or-admin-api>
  STRAPI_REPORT_DIR=logs/strapi-upload-reports
  STRAPI_UPLOAD_REPORT=logs/strapi-upload-reports/strapi-upload-report-....csv # optional override
  STRAPI_OFFICE=graha-cimb-niaga
  STRAPI_OFFICE_VENUE_MATCH_FIELD=slug
  STRAPI_OFFICE_VENUE_ID=99 # optional override
  STRAPI_CONFIRM_PRODUCTION=1
`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

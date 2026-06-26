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

async function main() {
  const options = parseOptions(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  if (!options.reportPath) {
    throw new Error('--report is required');
  }
  if (!options.officeVenueId) {
    throw new Error('--office-venue-id is required');
  }
  if (!options.token) {
    throw new Error('STRAPI_ADMIN_JWT or --token is required');
  }
  if (!options.confirm && !options.dryRun) {
    throw new Error('Use --confirm to update Strapi, or --dry-run to preview.');
  }

  await confirmProductionAccess(options);

  const csvPath = getCsvReportPath(options.reportPath);
  const markdownPath = getMarkdownReportPath(options.reportPath);
  const rows = parseCsv(await fs.readFile(csvPath, 'utf8'));
  const assets = getSuccessfulAssets(rows);

  if (assets.length === 0) {
    throw new Error(`No uploaded/skipped Strapi asset IDs found in ${csvPath}`);
  }

  const client = createClient(options);
  const beforeEntry = await getOfficeVenueEntry(client, options.officeVenueId);
  const existingComponents = normalizeComponentList(getEntryField(beforeEntry, options.contentField));
  const existingAssetIds = new Set(existingComponents.flatMap((component) => getMediaIds(component.imageUrl)));
  const missingAssets = assets.filter((asset) => !existingAssetIds.has(asset.id));
  const payloadComponents = [
    ...existingComponents.map(normalizeExistingImageComponent),
    ...missingAssets.map((asset) => buildNewImageComponent(options, asset)),
  ];

  console.log(`Office Venue ${options.officeVenueId}`);
  console.log(`Field: ${options.contentField}`);
  console.log(`Report assets: ${assets.length}`);
  console.log(`Already linked: ${assets.length - missingAssets.length}`);
  console.log(`To append: ${missingAssets.length}`);

  let afterEntry = beforeEntry;
  if (!options.dryRun) {
    await updateOfficeVenueImages(client, options.officeVenueId, options.contentField, payloadComponents);
    afterEntry = await getOfficeVenueEntry(client, options.officeVenueId);
  }

  const afterComponents = normalizeComponentList(getEntryField(afterEntry, options.contentField));
  const afterAssetIds = new Set(afterComponents.flatMap((component) => getMediaIds(component.imageUrl)));
  const linkedAssets = assets.filter((asset) => afterAssetIds.has(asset.id));
  const missingAfterUpdate = assets.filter((asset) => !afterAssetIds.has(asset.id));

  console.log(`Verified linked: ${linkedAssets.length}`);
  if (missingAfterUpdate.length > 0) {
    console.log(`Missing after verification: ${missingAfterUpdate.length}`);
  }

  if (!options.noReport) {
    await appendMarkdownRelationReport(markdownPath, {
      options,
      csvPath,
      assets,
      missingAssets,
      linkedAssets,
      missingAfterUpdate,
    });
  }

  if (!options.dryRun && missingAfterUpdate.length > 0) {
    process.exitCode = 1;
  }
}

function parseOptions(argv) {
  const parsed = parseArgv(argv);
  const reportPath = getValue(parsed, 'report') || process.env.STRAPI_UPLOAD_REPORT || '';
  const baseUrl = normalizeBaseUrl(getValue(parsed, 'base-url') || process.env.STRAPI_BASE_URL || DEFAULT_STRAPI_BASE_URL);

  return {
    help: hasFlag(parsed, 'help') || hasFlag(parsed, 'h'),
    reportPath,
    baseUrl,
    token: getValue(parsed, 'token') || process.env.STRAPI_ADMIN_JWT || '',
    officeVenueId: getValue(parsed, 'office-venue-id') || process.env.STRAPI_OFFICE_VENUE_ID || '',
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

async function updateOfficeVenueImages(client, id, field, components) {
  return requestJson(client, `/content-manager/collection-types/${encodeURIComponent(OFFICE_VENUE_UID)}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [field]: components }),
  });
}

async function requestJson(client, pathname, options = {}) {
  const url = new URL(pathname, `${client.baseUrl}/`);
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
  return {
    ...(component.id ? { id: component.id } : {}),
    imageUrl: getMediaIds(component.imageUrl),
    source: component.source || DEFAULT_COMPONENT_SOURCE,
    type: component.type || DEFAULT_COMPONENT_TYPE,
    subType: component.subType || component.sub_type || DEFAULT_COMPONENT_SUB_TYPE,
  };
}

function buildNewImageComponent(options, asset) {
  return {
    imageUrl: [asset.id],
    source: options.source,
    type: options.type,
    subType: options.subType,
  };
}

function getMediaIds(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map(getEntityId).filter(Boolean);
  }
  if (Array.isArray(value.data)) {
    return value.data.map(getEntityId).filter(Boolean);
  }
  const id = getEntityId(value);
  return id ? [id] : [];
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
      status: row.status || '',
    });
  }

  return [...assetsById.values()];
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
  const { options, csvPath, assets, missingAssets, linkedAssets, missingAfterUpdate } = result;
  const linkedIds = new Set(linkedAssets.map((asset) => asset.id));
  const appendedIds = new Set(missingAssets.map((asset) => asset.id));
  const lines = [];

  lines.push('');
  lines.push('## Strapi Content Relation');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Source CSV: ${csvPath}`);
  lines.push(`Content entry: ${options.baseUrl}/admin/content-manager/collectionType/${OFFICE_VENUE_UID}/${options.officeVenueId}`);
  lines.push(`Field: ${options.contentField}`);
  lines.push(`Component: office-venue-image.image`);
  lines.push(`Component defaults: source=${options.source}, type=${options.type}, subType=${options.subType}`);
  lines.push(`Mode: ${options.dryRun ? 'dry-run' : 'update'}`);
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('| --- | ---: |');
  lines.push(`| Report assets | ${assets.length} |`);
  lines.push(`| Newly appended | ${missingAssets.length} |`);
  lines.push(`| Verified linked | ${linkedAssets.length} |`);
  lines.push(`| Missing after verification | ${missingAfterUpdate.length} |`);
  lines.push('');
  lines.push('| Asset ID | Filename | Folder | Strapi URL | Relation Status |');
  lines.push('| ---: | --- | --- | --- | --- |');

  for (const asset of assets) {
    const status = linkedIds.has(asset.id)
      ? appendedIds.has(asset.id) ? 'linked_appended' : 'linked_existing'
      : 'missing';
    lines.push(`| ${asset.id} | ${escapeMarkdownCell(asset.filename)} | ${escapeMarkdownCell(asset.folder)} | ${escapeMarkdownCell(asset.url)} | ${status} |`);
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

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '').replace(/\/admin$/, '');
}

function escapeMarkdownCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function printHelp() {
  console.log(`Usage:
  node link-strapi-office-venue-images.mjs --report <csv-or-md> --office-venue-id <id> [options]

Required:
  --report <path>              Strapi upload report CSV or Markdown path.
  --office-venue-id <id>       Office Venue content id, e.g. 99.
  --confirm                    Actually update Strapi. Use --dry-run to preview.

Common options:
  --base-url <url>             Strapi base URL. Defaults to ${DEFAULT_STRAPI_BASE_URL}.
  --token <jwt>                Strapi admin JWT. Prefer STRAPI_ADMIN_JWT env var.
  --content-field <field>      Office Venue component field. Defaults to ${DEFAULT_CONTENT_FIELD}.
  --source <value>             Component source. Defaults to ${DEFAULT_COMPONENT_SOURCE}.
  --type <value>               Component type. Defaults to ${DEFAULT_COMPONENT_TYPE}.
  --sub-type <value>           Component subType. Defaults to ${DEFAULT_COMPONENT_SUB_TYPE}.
  --confirm-production         Allow access when STRAPI_BASE_URL is ${PRODUCTION_STRAPI_BASE_URL}.
  --no-report                  Do not append verification details to the Markdown report.

Environment variables:
  STRAPI_BASE_URL=${DEFAULT_STRAPI_BASE_URL}
  STRAPI_ADMIN_JWT=<admin-jwt-from-browser-or-admin-api>
  STRAPI_UPLOAD_REPORT=logs/strapi-upload-reports/strapi-upload-report-....csv
  STRAPI_OFFICE_VENUE_ID=99
  STRAPI_CONFIRM_PRODUCTION=1
`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

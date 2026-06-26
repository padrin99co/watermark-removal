#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_STRAPI_BASE_URL = 'https://cms.develop.99iddev.net';
const PRODUCTION_STRAPI_BASE_URL = 'https://cms.rumah123.com';
const DEFAULT_ROOT_FOLDER_PATH = 'Media Library/Office Venue';

async function main() {
  const startedAt = new Date();
  const options = parseOptions(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  if (typeof fetch !== 'function' || typeof FormData !== 'function' || typeof Blob !== 'function') {
    throw new Error('This script needs Node.js 18+ because it uses built-in fetch/FormData/Blob.');
  }

  const imageFiles = await collectImages(options.dir);
  if (imageFiles.length === 0) {
    throw new Error(`No supported images found in ${options.dir}`);
  }

  const hasApiConfig = Boolean(options.baseUrl && options.token && (options.rootFolderId || options.rootFolderPath || options.rootFolderName));
  const client = hasApiConfig ? createClient(options) : null;
  let rootFolderId = options.rootFolderId;
  let knownFolders = [];

  if (client) {
    await confirmProductionAccess(options);

    if (!rootFolderId) {
      const rootFolder = options.rootFolderPath
        ? await findFolderByPath(client, options.rootFolderPath)
        : await findFolderByName(client, options.rootFolderName);
      if (!rootFolder) {
        throw new Error(`Could not find root folder "${options.rootFolderPath || options.rootFolderName}".`);
      }
      rootFolderId = getEntityId(rootFolder);
    }

    knownFolders = await listFoldersByParent(client, rootFolderId);
  }

  const groups = groupImagesByOffice(imageFiles, knownFolders);
  const selectedGroups = selectGroups(groups, options);

  printSummary({
    imageCount: imageFiles.length,
    allGroups: groups,
    selectedGroups,
    knownFolders,
    dryRun: options.dryRun,
    hasApiConfig,
  });

  if (options.listOffices || options.dryRun) {
    if (!options.confirm && !options.listOffices) {
      console.log('\nDry run only. Add --confirm to upload.');
    }
    if (!options.listOffices && !options.noReport) {
      await writeUploadReport({
        options,
        mode: 'dry-run',
        startedAt,
        finishedAt: new Date(),
        rootFolderId,
        groups: createPlannedReportGroups(selectedGroups, knownFolders, getReportRootFolderPath(options, rootFolderId)),
      });
    }
    return;
  }

  if (!client || !rootFolderId) {
    throw new Error('Missing Strapi config. Set STRAPI_ADMIN_JWT and optionally STRAPI_BASE_URL plus STRAPI_ROOT_FOLDER_ID/STRAPI_ROOT_FOLDER_PATH, or pass their CLI options.');
  }

  const uploadReportGroups = await uploadGroups({
    client,
    rootFolderId,
    rootFolderPath: getReportRootFolderPath(options, rootFolderId),
    groups: selectedGroups,
    knownFolders,
    createFolders: options.createFolders,
    skipExisting: options.skipExisting,
    folderField: options.folderField,
  });

  if (!options.noReport) {
    await writeUploadReport({
      options,
      mode: 'upload',
      startedAt,
      finishedAt: new Date(),
      rootFolderId,
      groups: uploadReportGroups,
    });
  } else if (options.existingFilenamesPath) {
    await updateExistingFilenamesFromGroups(options.existingFilenamesPath, uploadReportGroups);
  }
}

function parseOptions(argv) {
  const parsed = parseArgv(argv);
  const dir = path.resolve(getValue(parsed, 'dir') || process.cwd());
  const confirm = hasFlag(parsed, 'confirm');
  const explicitDryRun = hasFlag(parsed, 'dry-run');

  if (confirm && explicitDryRun) {
    throw new Error('Use either --confirm or --dry-run, not both.');
  }

  const officeFilters = getValues(parsed, 'office')
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);

  const folderField = getValue(parsed, 'folder-field') || 'auto';
  if (!['auto', 'fileInfo', 'top-level', 'both'].includes(folderField)) {
    throw new Error('--folder-field must be one of: auto, fileInfo, top-level, both');
  }

  const rootFolderId = getValue(parsed, 'root-folder-id') || process.env.STRAPI_ROOT_FOLDER_ID || '';
  const rootFolderPath = getValue(parsed, 'root-folder-path') || process.env.STRAPI_ROOT_FOLDER_PATH || '';
  const rootFolderName = getValue(parsed, 'root-folder-name') || process.env.STRAPI_ROOT_FOLDER_NAME || '';

  return {
    help: hasFlag(parsed, 'help') || hasFlag(parsed, 'h'),
    dir,
    baseUrl: normalizeBaseUrl(getValue(parsed, 'base-url') || process.env.STRAPI_BASE_URL || DEFAULT_STRAPI_BASE_URL),
    token: getValue(parsed, 'token') || process.env.STRAPI_ADMIN_JWT || '',
    rootFolderId,
    rootFolderPath: rootFolderId ? '' : rootFolderPath || (rootFolderName ? '' : DEFAULT_ROOT_FOLDER_PATH),
    rootFolderName,
    officeFilters,
    oneOffice: hasFlag(parsed, 'one-office'),
    listOffices: hasFlag(parsed, 'list-offices'),
    dryRun: explicitDryRun || !confirm,
    confirm,
    confirmProduction: hasFlag(parsed, 'confirm-production') || process.env.STRAPI_CONFIRM_PRODUCTION === '1',
    createFolders: !hasFlag(parsed, 'no-create-folders'),
    skipExisting: !hasFlag(parsed, 'no-skip-existing'),
    folderField,
    reportDir: path.resolve(getValue(parsed, 'report-dir') || process.env.STRAPI_REPORT_DIR || path.join(dir, 'strapi-upload-reports')),
    existingFilenamesPath: getValue(parsed, 'existing-filenames') || process.env.STRAPI_EXISTING_FILENAMES || '',
    noReport: hasFlag(parsed, 'no-report'),
    pageSize: Number(getValue(parsed, 'page-size') || process.env.STRAPI_PAGE_SIZE || DEFAULT_PAGE_SIZE),
  };
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
      throw new Error('Production upload aborted.');
    }
  } finally {
    rl.close();
  }
}

function isProductionBaseUrl(baseUrl) {
  return normalizeBaseUrl(baseUrl) === PRODUCTION_STRAPI_BASE_URL;
}

function parseArgv(argv) {
  const values = new Map();
  const flags = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    if (equalsIndex !== -1) {
      addValue(values, withoutPrefix.slice(0, equalsIndex), withoutPrefix.slice(equalsIndex + 1));
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      addValue(values, withoutPrefix, next);
      index += 1;
    } else {
      flags.add(withoutPrefix);
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

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) {
    return '';
  }

  return baseUrl.trim().replace(/\/+$/, '').replace(/\/admin$/, '');
}

async function collectImages(rootDir) {
  const files = [];

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(parseLocalImage(fullPath, rootDir));
      }
    }
  }

  await walk(rootDir);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en', { numeric: true }));
}

function parseLocalImage(filePath, rootDir) {
  const relativePath = path.relative(rootDir, filePath);
  const filename = path.basename(filePath);
  const ext = path.extname(filename);
  const stem = filename.slice(0, -ext.length);
  const match = filename.match(/^(\d+)_([^_]+)_(.+)_(\d{14})_(\d+)\.[^.]+$/i);
  const exteriorMatch = filename.match(/^(\d+)_(.+)-exterior-\d+-\d+\.[^.]+$/i);

  if (match) {
    return {
      filePath,
      relativePath,
      filename,
      stem,
      ext,
      sequence: Number(match[1]),
      officeId: match[2],
      rawSlug: cleanOfficeSlug(match[3]),
      capturedAt: match[4],
    };
  }

  if (exteriorMatch) {
    return {
      filePath,
      relativePath,
      filename,
      stem,
      ext,
      sequence: Number(exteriorMatch[1]),
      officeId: '',
      rawSlug: cleanOfficeSlug(exteriorMatch[2]),
    };
  }

  return {
    filePath,
    relativePath,
    filename,
    stem,
    ext,
    sequence: 0,
    officeId: '',
    rawSlug: cleanOfficeSlug(stem),
  };
}

function cleanOfficeSlug(value) {
  return String(value)
    .toLowerCase()
    .replace(/_28/g, '')
    .replace(/_29/g, '')
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function groupImagesByOffice(imageFiles, knownFolders) {
  const knownNames = knownFolders.map((folder) => folder.name).filter(Boolean);
  const groups = new Map();

  for (const image of imageFiles) {
    const officeName = resolveOfficeName(image.rawSlug, knownNames);
    if (!groups.has(officeName)) {
      groups.set(officeName, []);
    }
    groups.get(officeName).push({ ...image, officeName });
  }

  return [...groups.entries()]
    .map(([officeName, files]) => ({ officeName, files }))
    .sort((a, b) => a.officeName.localeCompare(b.officeName, 'en', { numeric: true }));
}

function resolveOfficeName(rawSlug, knownNames) {
  const exact = knownNames.find((name) => normalizeKey(name) === normalizeKey(rawSlug));
  if (exact) {
    return exact;
  }

  const suffixMatch = knownNames
    .filter((name) => normalizeKey(rawSlug).endsWith(`-${normalizeKey(name)}`))
    .sort((a, b) => b.length - a.length)[0];

  if (suffixMatch) {
    return suffixMatch;
  }

  return deriveOfficeName(rawSlug);
}

function deriveOfficeName(rawSlug) {
  const tokens = rawSlug.split('-').filter(Boolean);
  if (tokens.length < 3) {
    return rawSlug;
  }

  for (let halfLength = Math.floor(tokens.length / 2); halfLength >= 1; halfLength -= 1) {
    if (tokens.length === halfLength * 2) {
      const firstHalf = tokens.slice(0, halfLength).join('-');
      const secondHalf = tokens.slice(halfLength).join('-');
      if (firstHalf === secondHalf) {
        return firstHalf;
      }
    }
  }

  for (let index = tokens.length - 2; index >= 1; index -= 1) {
    if (tokens[index] === tokens[0] && tokens[index + 1] === tokens[1]) {
      return tokens.slice(index).join('-');
    }
  }

  return rawSlug;
}

function selectGroups(groups, options) {
  let selected = groups;

  if (options.officeFilters.length > 0) {
    const filters = new Set(options.officeFilters.map(normalizeKey));
    selected = groups.filter((group) => filters.has(normalizeKey(group.officeName)));

    const found = new Set(selected.map((group) => normalizeKey(group.officeName)));
    const missing = options.officeFilters.filter((office) => !found.has(normalizeKey(office)));
    if (missing.length > 0) {
      throw new Error(`Office not found in local images: ${missing.join(', ')}`);
    }
  }

  if (options.oneOffice) {
    selected = selected.slice(0, 1);
  }

  return selected;
}

function createClient(options) {
  return {
    baseUrl: options.baseUrl,
    token: options.token,
    pageSize: options.pageSize,
  };
}

async function findFolderByName(client, folderName) {
  const folders = await listAll(client, '/upload/folders', {
    'filters[name][$eq]': folderName,
    sort: 'name:ASC',
  });

  return folders.find((folder) => normalizeKey(folder.name) === normalizeKey(folderName));
}

async function findFolderByPath(client, folderPath) {
  const parts = String(folderPath)
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);

  if (normalizeKey(parts[0]) === 'media library') {
    parts.shift();
  }

  if (parts.length === 0) {
    return null;
  }

  let current = await findFolderByName(client, parts[0]);
  for (const part of parts.slice(1)) {
    if (!current) {
      return null;
    }

    const children = await listFoldersByParent(client, getEntityId(current));
    current = children.find((folder) => normalizeKey(folder.name) === normalizeKey(part));
  }

  return current;
}

async function listFoldersByParent(client, parentId) {
  return listAll(client, '/upload/folders', {
    'filters[parent][id][$eq]': parentId,
    sort: 'name:ASC',
  });
}

async function listFilesByFolder(client, folderId) {
  return listAll(client, '/upload/files', {
    'filters[folder][id][$eq]': folderId,
    sort: 'name:ASC',
  }, 'plain');
}

async function listAll(client, pathname, baseParams, paginationStyle = 'nested') {
  const all = [];
  let page = 1;

  while (true) {
    const body = await requestJson(client, pathname, {
      params: {
        ...baseParams,
        ...getPaginationParams(paginationStyle, page, client.pageSize),
      },
    });

    const items = unwrapList(body);
    all.push(...items);

    const pagination = getPagination(body);
    if (!pagination) {
      break;
    }

    if (pagination.pageCount && page >= Number(pagination.pageCount)) {
      break;
    }

    if (pagination.total && all.length >= Number(pagination.total)) {
      break;
    }

    if (items.length === 0) {
      break;
    }

    page += 1;
  }

  return all;
}

function getPaginationParams(style, page, pageSize) {
  if (style === 'plain') {
    return { page, pageSize };
  }

  return {
    'pagination[page]': page,
    'pagination[pageSize]': pageSize,
  };
}

async function uploadGroups({ client, rootFolderId, rootFolderPath, groups, knownFolders, createFolders, skipExisting, folderField }) {
  const foldersByName = new Map(knownFolders.map((folder) => [normalizeKey(folder.name), folder]));
  const reportGroups = [];
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  if (skipExisting) {
    console.log('Duplicate check enabled: assets with the same Strapi name in the same folder will be skipped.');
  }

  for (const group of groups) {
    let folder = foldersByName.get(normalizeKey(group.officeName));
    let folderCreated = false;
    if (!folder) {
      if (!createFolders) {
        throw new Error(`Folder "${group.officeName}" does not exist and --no-create-folders was passed.`);
      }

      folder = await createFolder(client, group.officeName, rootFolderId);
      folderCreated = true;
      foldersByName.set(normalizeKey(group.officeName), folder);
      console.log(`Created folder: ${group.officeName} (id ${getEntityId(folder)})`);
    }

    const folderId = getEntityId(folder);
    const existingFilesBefore = await listFilesByFolder(client, folderId);
    const existingNames = skipExisting ? getExistingFileNames(client, existingFilesBefore) : new Map();
    const reportGroup = {
      officeName: group.officeName,
      folderId,
      folderPath: buildMediaLibraryFolderPath(rootFolderPath, group.officeName),
      folderCreated,
      localImageCount: group.files.length,
      beforeAssetCount: existingFilesBefore.length,
      afterAssetCount: null,
      uploaded: 0,
      skipped: 0,
      failed: 0,
      files: [],
    };

    console.log(`\nUploading ${group.files.length} image(s) to ${reportGroup.folderPath} (folder id ${folderId})`);
    for (const file of group.files) {
      const existingFile = skipExisting ? findExistingFile(existingNames, file) : null;
      if (existingFile) {
        const existingName = existingFile.name;
        const strapiUrl = existingFile.url;
        skipped += 1;
        reportGroup.skipped += 1;
        reportGroup.files.push({
          filename: file.filename,
          status: 'skipped_existing',
          reason: 'Same name already exists in this Strapi folder',
          existingMatch: existingName,
          strapiAssetId: existingFile.id,
          strapiAssetName: existingFile.assetName,
          strapiUrl,
        });
        console.log(`- skip existing ${file.filename} in ${reportGroup.folderPath} (matched ${existingName}${existingFile.assetName ? `, asset name ${existingFile.assetName}` : ''}${strapiUrl ? `, ${strapiUrl}` : ''})`);
        continue;
      }

      try {
        const uploadedFile = await uploadFile(client, file, folderId, folderField);
        const strapiUrl = getStrapiFileUrl(client, uploadedFile);
        const strapiAssetId = getEntityId(uploadedFile);
        const strapiAssetName = getStrapiFileName(uploadedFile);
        uploaded += 1;
        reportGroup.uploaded += 1;
        rememberUploadedFile(existingNames, file, { id: strapiAssetId, assetName: strapiAssetName, url: strapiUrl });
        reportGroup.files.push({
          filename: file.filename,
          status: 'uploaded',
          reason: '',
          existingMatch: '',
          strapiAssetId,
          strapiAssetName,
          strapiUrl,
        });
        console.log(`- uploaded ${file.filename} to ${reportGroup.folderPath}${strapiAssetName ? ` (asset name ${strapiAssetName})` : ''}`);
      } catch (error) {
        failed += 1;
        reportGroup.failed += 1;
        reportGroup.files.push({
          filename: file.filename,
          status: 'failed',
          reason: error.message,
          existingMatch: '',
        });
        console.log(`- failed ${file.filename}: ${error.message}`);
      }
    }

    const existingFilesAfter = await listFilesByFolder(client, folderId);
    reportGroup.afterAssetCount = existingFilesAfter.length;
    reportGroups.push(reportGroup);
  }

  console.log(`\nComplete. Uploaded ${uploaded}, skipped ${skipped}, failed ${failed}.`);
  return reportGroups;
}

async function createFolder(client, name, parentId) {
  const body = await requestJson(client, '/upload/folders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, parent: idValue(parentId) }),
  });

  return unwrapSingle(body);
}

async function uploadFile(client, file, folderId, folderField) {
  const placements = folderField === 'auto' ? ['fileInfo', 'top-level', 'both'] : [folderField];
  let lastError;

  for (const placement of placements) {
    try {
      const form = await buildUploadForm(file, folderId, placement);
      const body = await requestJson(client, '/upload', {
        method: 'POST',
        body: form,
      });
      return unwrapUploadFile(body);
    } catch (error) {
      lastError = error;
      if (!(error instanceof HttpError) || ![400, 422].includes(error.status) || folderField !== 'auto') {
        throw error;
      }
    }
  }

  throw lastError;
}

async function buildUploadForm(file, folderId, placement) {
  const buffer = await fs.readFile(file.filePath);
  const form = new FormData();
  const fileInfo = {
    name: file.filename,
    alternativeText: file.officeName,
    caption: file.officeName,
  };

  if (placement === 'fileInfo' || placement === 'both') {
    fileInfo.folder = idValue(folderId);
  }

  if (placement === 'top-level' || placement === 'both') {
    form.append('folder', String(folderId));
  }

  form.append('fileInfo', JSON.stringify(fileInfo));
  form.append('files', new Blob([buffer], { type: getMimeType(file.ext) }), file.filename);
  return form;
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
    throw new HttpError(response.status, buildHttpErrorMessage(response.status, options.method || 'GET', url, client), body || text);
  }

  return body;
}

function buildHttpErrorMessage(status, method, url, client) {
  const message = `${method} ${url.pathname} failed`;

  if (status === 401) {
    return `${message}. Refresh STRAPI_ADMIN_JWT from ${client.baseUrl}/admin and make sure it belongs to this develop CMS`;
  }

  if (status === 403) {
    return `${message}. The token is valid, but it does not have permission to access this Strapi upload endpoint`;
  }

  return message;
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

function unwrapList(body) {
  if (Array.isArray(body)) {
    return body.map(normalizeEntity);
  }

  if (Array.isArray(body?.data)) {
    return body.data.map(normalizeEntity);
  }

  if (Array.isArray(body?.results)) {
    return body.results.map(normalizeEntity);
  }

  if (Array.isArray(body?.files)) {
    return body.files.map(normalizeEntity);
  }

  return [];
}

function unwrapSingle(body) {
  if (body?.data) {
    return normalizeEntity(body.data);
  }

  if (body?.result) {
    return normalizeEntity(body.result);
  }

  return normalizeEntity(body);
}

function unwrapUploadFile(body) {
  const files = unwrapList(body);
  if (files.length > 0) {
    return files[0];
  }

  return unwrapSingle(body);
}

function getStrapiFileUrl(client, file) {
  const rawUrl = file?.url;
  if (!rawUrl) {
    return '';
  }

  return new URL(rawUrl, `${client.baseUrl}/`).toString();
}

function getStrapiFileName(file) {
  if (!file || typeof file !== 'object') {
    return '';
  }

  if (file.name) {
    return String(file.name);
  }

  if (file.filename) {
    return String(file.filename);
  }

  if (file.url) {
    return path.posix.basename(String(file.url));
  }

  return '';
}

function normalizeEntity(entity) {
  if (!entity || typeof entity !== 'object') {
    return entity;
  }

  if (entity.attributes && typeof entity.attributes === 'object') {
    return { id: entity.id, documentId: entity.documentId, ...entity.attributes };
  }

  return entity;
}

function getPagination(body) {
  return body?.meta?.pagination || body?.pagination || null;
}

function getEntityId(entity) {
  return entity?.id ?? entity?.documentId;
}

function idValue(value) {
  const text = String(value);
  return /^\d+$/.test(text) ? Number(text) : value;
}

function getExistingFileNames(client, files) {
  const names = new Map();

  for (const file of files) {
    const name = file.name ? String(file.name) : '';
    const ext = file.ext ? String(file.ext) : '';
    const urlName = file.url ? path.posix.basename(String(file.url)) : '';
    const fileInfo = {
      name,
      id: getEntityId(file),
      assetName: getStrapiFileName(file),
      url: getStrapiFileUrl(client, file),
    };

    addExistingName(names, name, fileInfo);
    addExistingName(names, name && ext ? `${name}${ext}` : '', { ...fileInfo, name: `${name}${ext}` });
    addExistingName(names, file.filename ? String(file.filename) : '', { ...fileInfo, name: String(file.filename || name) });
    addExistingName(names, urlName, { ...fileInfo, name: urlName });
  }

  return names;
}

function addExistingName(names, value, fileInfo) {
  if (!value) {
    return;
  }

  names.set(normalizeKey(value), fileInfo || { name: value, url: '' });
}

function findExistingFile(existingNames, file) {
  return existingNames.get(normalizeKey(file.filename)) || existingNames.get(normalizeKey(file.stem)) || null;
}

function rememberUploadedFile(existingNames, file, strapiFile = {}) {
  addExistingName(existingNames, file.filename, { name: file.filename, ...strapiFile });
  addExistingName(existingNames, file.stem, { name: file.stem, ...strapiFile });
}

function getReportRootFolderPath(options, rootFolderId) {
  if (options.rootFolderPath) {
    return options.rootFolderPath;
  }

  if (options.rootFolderName) {
    return `Media Library/${options.rootFolderName}`;
  }

  if (rootFolderId) {
    return `Media Library/root folder ${rootFolderId}`;
  }

  return 'Media Library';
}

function buildMediaLibraryFolderPath(rootFolderPath, officeName) {
  return [rootFolderPath, officeName]
    .map((part) => String(part || '').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

function createPlannedReportGroups(groups, knownFolders, rootFolderPath) {
  const foldersByName = new Map(knownFolders.map((folder) => [normalizeKey(folder.name), folder]));

  return groups.map((group) => {
    const folder = foldersByName.get(normalizeKey(group.officeName));

    return {
      officeName: group.officeName,
      folderId: folder ? getEntityId(folder) : '',
      folderPath: buildMediaLibraryFolderPath(rootFolderPath, group.officeName),
      folderCreated: false,
      localImageCount: group.files.length,
      beforeAssetCount: null,
      afterAssetCount: null,
      uploaded: 0,
      skipped: 0,
      failed: 0,
      files: group.files.map((file) => ({
        filename: file.filename,
        status: 'planned',
        reason: 'Dry run only',
        existingMatch: '',
      })),
    };
  });
}

async function writeUploadReport({ options, mode, startedAt, finishedAt, rootFolderId, groups }) {
  const timestamp = fileTimestamp(finishedAt);
  const basename = `strapi-upload-report-${timestamp}`;
  const markdownPath = path.join(options.reportDir, `${basename}.md`);
  const csvPath = path.join(options.reportDir, `${basename}.csv`);

  await fs.mkdir(options.reportDir, { recursive: true });
  await fs.writeFile(markdownPath, buildMarkdownReport({ options, mode, startedAt, finishedAt, rootFolderId, groups }), 'utf8');
  await fs.writeFile(csvPath, buildCsvReport({ groups }), 'utf8');

  console.log(`\nReport written:`);
  console.log(`- ${markdownPath}`);
  console.log(`- ${csvPath}`);

  if (mode === 'upload' && options.existingFilenamesPath) {
    await updateExistingFilenamesFromGroups(options.existingFilenamesPath, groups);
  }
}

async function updateExistingFilenamesFromGroups(existingFilenamesPath, groups) {
  const done = new Set(['uploaded', 'skipped_existing']);
  const names = groups
    .flatMap((group) => group.files)
    .filter((file) => done.has(file.status))
    .map((file) => file.filename)
    .filter(Boolean);

  const existing = await readExistingFilenameRules(existingFilenamesPath);
  const merged = [...new Set([...existing, ...names])].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

  await fs.mkdir(path.dirname(existingFilenamesPath), { recursive: true });
  await fs.writeFile(existingFilenamesPath, `${merged.join('\n')}${merged.length ? '\n' : ''}`, 'utf8');

  console.log(`Updated ${existingFilenamesPath}: added ${names.length} uploaded/existing filename(s).`);
}

async function readExistingFilenameRules(existingFilenamesPath) {
  try {
    const text = await fs.readFile(existingFilenamesPath, 'utf8');
    return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

function buildMarkdownReport({ options, mode, startedAt, finishedAt, rootFolderId, groups }) {
  const totals = summarizeReportGroups(groups);
  const durationSeconds = Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000);
  const lines = [];

  lines.push('# Strapi Upload Report');
  lines.push('');
  lines.push(`Generated: ${finishedAt.toISOString()}`);
  lines.push(`Mode: ${mode}`);
  lines.push(`Source directory: ${options.dir}`);
  lines.push(`Strapi base URL: ${options.baseUrl || 'not configured'}`);
  lines.push(`Root folder id: ${rootFolderId || 'not configured'}`);
  lines.push(`Duplicate check: ${options.skipExisting ? 'enabled' : 'disabled'}`);
  lines.push(`Duration: ${durationSeconds}s`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('| --- | ---: |');
  lines.push(`| Offices | ${groups.length} |`);
  lines.push(`| Local images | ${totals.localImageCount} |`);
  lines.push(`| Planned | ${totals.planned} |`);
  lines.push(`| Uploaded | ${totals.uploaded} |`);
  lines.push(`| Skipped existing | ${totals.skipped} |`);
  lines.push(`| Failed | ${totals.failed} |`);
  lines.push('');
  lines.push('## Office Summary');
  lines.push('');
  lines.push('| Office | Media Library Folder | Folder ID | Before | Local | Uploaded | Skipped | Failed | After |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');

  for (const group of groups) {
    lines.push(`| ${escapeMarkdownCell(group.officeName)} | ${escapeMarkdownCell(group.folderPath)} | ${emptyIfNull(group.folderId)} | ${emptyIfNull(group.beforeAssetCount)} | ${group.localImageCount} | ${group.uploaded} | ${group.skipped} | ${group.failed} | ${emptyIfNull(group.afterAssetCount)} |`);
  }

  lines.push('');
  lines.push('## File Details');

  for (const group of groups) {
    lines.push('');
    lines.push(`### ${group.officeName}`);
    lines.push('');
    lines.push('| Status | File | Media Library Folder | Strapi Asset ID | Strapi Asset Name | Strapi URL | Notes |');
    lines.push('| --- | --- | --- | ---: | --- | --- | --- |');

    for (const file of group.files) {
      const notes = [file.reason, file.existingMatch ? `matched: ${file.existingMatch}` : ''].filter(Boolean).join('; ');
      lines.push(`| ${file.status} | ${escapeMarkdownCell(file.filename)} | ${escapeMarkdownCell(group.folderPath)} | ${escapeMarkdownCell(file.strapiAssetId)} | ${escapeMarkdownCell(file.strapiAssetName)} | ${escapeMarkdownCell(file.strapiUrl)} | ${escapeMarkdownCell(notes)} |`);
    }
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

function buildCsvReport({ groups }) {
  const rows = [
    [
      'office_name',
      'media_library_folder',
      'folder_id',
      'before_asset_count',
      'after_asset_count',
      'local_image_count',
      'filename',
      'status',
      'strapi_asset_id',
      'strapi_asset_name',
      'strapi_url',
      'reason',
      'existing_match',
    ],
  ];

  for (const group of groups) {
    for (const file of group.files) {
      rows.push([
        group.officeName,
        group.folderPath,
        group.folderId,
        emptyIfNull(group.beforeAssetCount),
        emptyIfNull(group.afterAssetCount),
        group.localImageCount,
        file.filename,
        file.status,
        file.strapiAssetId,
        file.strapiAssetName,
        file.strapiUrl,
        file.reason,
        file.existingMatch,
      ]);
    }
  }

  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function summarizeReportGroups(groups) {
  const totals = {
    localImageCount: 0,
    planned: 0,
    uploaded: 0,
    skipped: 0,
    failed: 0,
  };

  for (const group of groups) {
    totals.localImageCount += group.localImageCount;
    totals.uploaded += group.uploaded;
    totals.skipped += group.skipped;
    totals.failed += group.failed;
    totals.planned += group.files.filter((file) => file.status === 'planned').length;
  }

  return totals;
}

function fileTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function emptyIfNull(value) {
  return value === null || value === undefined ? '' : String(value);
}

function escapeMarkdownCell(value) {
  return emptyIfNull(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function csvCell(value) {
  const text = emptyIfNull(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function getMimeType(ext) {
  switch (ext.toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.avif':
      return 'image/avif';
    case '.gif':
      return 'image/gif';
    default:
      return 'application/octet-stream';
  }
}

function normalizeKey(value) {
  return String(value).trim().toLowerCase();
}

function printSummary({ imageCount, allGroups, selectedGroups, knownFolders, dryRun, hasApiConfig }) {
  const mode = dryRun ? 'DRY RUN' : 'UPLOAD';
  console.log(`${mode}: found ${imageCount} image(s) across ${allGroups.length} office folder(s).`);

  if (hasApiConfig) {
    console.log(`Matched against ${knownFolders.length} existing Strapi folder(s) under the root folder.`);
  } else {
    console.log('No Strapi API config provided, so office names are resolved from filenames only.');
  }

  console.log(`Selected ${selectedGroups.length} office folder(s):`);
  for (const group of selectedGroups) {
    console.log(`- ${group.officeName}: ${group.files.length} image(s)`);
  }
}

function printHelp() {
  console.log(`Usage:
  node upload-strapi-images.mjs [options]

Required for upload:
  --base-url <url>             Strapi base URL. Defaults to ${DEFAULT_STRAPI_BASE_URL}.
  --token <jwt>                Strapi admin JWT. Prefer STRAPI_ADMIN_JWT env var.
  --root-folder-id <id>        Media Library root folder id. Overrides path lookup.
  --root-folder-path <path>    Media Library root folder path. Defaults to ${DEFAULT_ROOT_FOLDER_PATH}.

Common options:
  --dir <path>                 Image directory. Defaults to current directory.
  --office <slug>              Upload only one office, e.g. --office zuria-tower.
  --one-office                 Select only the first resolved office.
  --list-offices               Print resolved offices and exit.
  --dry-run                    Print what would happen. This is the default.
  --confirm                    Actually create folders and upload files.
  --confirm-production         Allow upload when STRAPI_BASE_URL is ${PRODUCTION_STRAPI_BASE_URL}.
  --no-create-folders          Fail if a target office folder does not exist.
  --no-skip-existing           Upload even when same Strapi name already exists.
  --folder-field <mode>        auto, fileInfo, top-level, or both. Defaults to auto.
  --report-dir <path>          Report output directory. Defaults to ./strapi-upload-reports.
  --existing-filenames <path>  Write uploaded/skipped filenames to this rules file.
  --no-report                  Do not write Markdown/CSV report files.

Environment variables:
  STRAPI_BASE_URL=${DEFAULT_STRAPI_BASE_URL}
  STRAPI_CONFIRM_PRODUCTION=1
  STRAPI_ADMIN_JWT=<admin-jwt-from-browser-or-admin-api>
  STRAPI_ROOT_FOLDER_PATH="${DEFAULT_ROOT_FOLDER_PATH}"
  STRAPI_ROOT_FOLDER_ID=<optional-root-folder-id>
  STRAPI_REPORT_DIR=./strapi-upload-reports
  STRAPI_EXISTING_FILENAMES=rules/strapi-office-venue-existing-filenames.txt

Example one-office upload:
  STRAPI_ADMIN_JWT=<token> node upload-strapi-images.mjs --office zuria-tower --confirm
`);
}

class HttpError extends Error {
  constructor(status, message, details) {
    super(`${message}: HTTP ${status}${details ? ` ${JSON.stringify(details)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveOfficeName, resolveOfficeName } from '../scripts/upload-strapi-images.mjs';


test('groups category timestamp filenames under the venue slug', () => {
  assert.equal(deriveOfficeName('the-garden-center-interior-1762497951525-3'), 'the-garden-center');
  assert.equal(deriveOfficeName('the-garden-center-exterior-1762497689469-1'), 'the-garden-center');
  assert.equal(deriveOfficeName('the-garden-center-floor-plan-1762497000000-0'), 'the-garden-center');
});


test('prefers the longest known venue prefix', () => {
  const known = ['the-garden', 'the-garden-center', 'the-garden-center-interior-1762497951525-3'];
  assert.equal(resolveOfficeName('the-garden-center-interior-1762497951525-3', known), 'the-garden-center');
});


test('keeps legacy suffix matching for prefixed identifiers', () => {
  assert.equal(resolveOfficeName('123-menara-dea-i', ['menara-dea-i']), 'menara-dea-i');
});

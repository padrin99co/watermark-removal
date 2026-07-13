import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAppendPlan,
  buildManifestVenueGroups,
  countComponentsByCategory,
} from '../scripts/link-strapi-office-venue-images.mjs';


test('manifest grouping uses explicit Office Venue IDs', () => {
  const manifest = {
    unresolved: [],
    venues: [{
      officeVenueId: 336,
      buildingId: '7',
      buildingName: 'Graha Mustika Ratu',
      expected: { exterior: 5, interior: 10, floorplan: 2 },
      assets: [{ assetId: 90, cleanFilename: 'graha-mustika-ratu-interior.jpg', category: 'interior' }],
    }],
  };
  const groups = buildManifestVenueGroups(manifest);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].officeVenueId, 336);
  assert.equal(groups[0].assets[0].id, 90);
  assert.equal(groups[0].assets[0].subType, 'Foto Lainnya');
});


test('append plan preserves components and skips already-linked IDs', () => {
  const existing = [{ id: 5, source: 'Legacy', type: 'Top Preview', subType: 'Foto Lainnya', imageUrl: [{ id: 90 }] }];
  const assets = [
    { id: 90, filename: 'existing.jpg', category: 'interior', subType: 'Foto Lainnya' },
    { id: 91, filename: 'new.jpg', category: 'exterior', subType: 'Fasad Gedung' },
  ];
  const plan = buildAppendPlan(existing, assets, { source: 'Rumah123', type: 'Top Preview', subType: 'Fasad Gedung' });
  assert.deepEqual(plan.missingAssets.map((asset) => asset.id), [91]);
  assert.equal(plan.payloadComponents.length, 2);
  assert.equal(plan.payloadComponents[0].id, 5);
  assert.deepEqual(plan.payloadComponents[0].imageUrl, [90]);
  assert.deepEqual(plan.payloadComponents[1].imageUrl, [91]);
});


test('append plan skips a clean asset already represented by a sequenced legacy filename', () => {
  const existing = [{
    id: 6,
    source: 'Rumah123',
    type: 'Top Preview',
    subType: 'Foto Lainnya',
    imageUrl: [{ id: 50, name: '01_7_graha-mustika-ratu_20180416093838_75744.jpg' }],
  }];
  const assets = [{
    id: 90,
    filename: '7_graha-mustika-ratu_20180416093838_75744.jpg',
    category: 'interior',
    subType: 'Foto Lainnya',
  }];
  const plan = buildAppendPlan(existing, assets, { source: 'Rumah123', type: 'Top Preview', subType: 'Fasad Gedung' });
  assert.deepEqual(plan.missingAssets, []);
  assert.equal(plan.payloadComponents.length, 1);
});


test('append plan limits each category to the fresh workbook deficit', () => {
  const existing = [{ id: 7, subType: 'Foto Lainnya', imageUrl: [{ id: 50, name: 'legacy.jpg' }] }];
  const assets = [
    { id: 91, filename: 'one.jpg', category: 'interior', subType: 'Foto Lainnya' },
    { id: 92, filename: 'two.jpg', category: 'interior', subType: 'Foto Lainnya' },
    { id: 93, filename: 'three.jpg', category: 'interior', subType: 'Foto Lainnya' },
  ];
  const plan = buildAppendPlan(
    existing,
    assets,
    { source: 'Rumah123', type: 'Top Preview', subType: 'Fasad Gedung' },
    { exterior: 0, interior: 2, floorplan: 0 },
  );
  assert.deepEqual(plan.missingAssets.map((asset) => asset.id), [91]);
  assert.deepEqual(plan.requiredAssets.map((asset) => asset.id), [91]);
  assert.equal(plan.payloadComponents.length, 2);
});


test('category counts are derived from component subtype without mutation', () => {
  const components = [
    { subType: 'Fasad Gedung', imageUrl: { id: 1 } },
    { subType: 'Foto Lainnya', imageUrl: { id: 2 } },
    { subType: 'Denah Ruang', imageUrl: { id: 3 } },
    { subType: 'Foto Lainnya', imageUrl: { id: 4 } },
  ];
  assert.deepEqual(countComponentsByCategory(components), { exterior: 1, interior: 2, floorplan: 1 });
});

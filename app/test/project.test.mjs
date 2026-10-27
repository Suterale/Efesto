// A crafted project file must be refused before any of its values reach the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkProject } from '../js/project.js';

const example = () => JSON.parse(readFileSync(new URL('../../examples/esempio-fusione.sdfcad.json', import.meta.url)));
const box = extra => ({ id: 1, type: 'box', color: '#ff5555', pos: [0, 0, 0], ...extra });
const refused = data => assert.throws(() => checkProject(data));

test('the example project passes', () => {
  assert.doesNotThrow(() => checkProject(example()));
});

test('markup in a colour is refused', () => {
  refused({ objects: [box({ color: 'red"><img src=x onerror=alert(1)>' })] });
  refused({ objects: [box({ color: 'red' })] });
});

test('fields of the wrong type are refused', () => {
  refused({ objects: [box({ pos: [0, 0, '1'] })] });
  refused({ objects: [box({ blend: Infinity })] });
  refused({ objects: [box({ hole: 'no' })] });
  refused({ objects: [{ id: 1, type: 'script' }] });
  refused({ objects: [{ id: 2, type: 'group', mode: '<b>' }] });
  refused({ objects: 'nope' });
});

test('looping groups and repeated ids are refused', () => {
  refused({ objects: [{ id: 1, type: 'group', mode: 'group', parent: 2 }, { id: 2, type: 'group', mode: 'group', parent: 1 }] });
  refused({ objects: [box(), box()] });
});

test('images must be inline pictures, meshes plain numbers', () => {
  const img = { src: 'data:image/png;base64,AAAA', w: 10, h: 10, thumb: 'data:image/png;base64,AA==' };
  assert.doesNotThrow(() => checkProject({ objects: [], images: { a: img } }));
  refused({ objects: [], images: { a: { ...img, src: 'https://example.com/track.png' } } });
  refused({ objects: [], images: { a: { ...img, thumb: 'data:image/png;base64,AA")' } } });
  const mesh = { tris: 12, w: 10, h: 10, d: 10, cell: 0.5, ext: [4, 4, 4], src: 'H4sI' };
  assert.doesNotThrow(() => checkProject({ objects: [], meshes: { m: mesh } }));
  refused({ objects: [], meshes: { m: { ...mesh, tris: '<img src=x onerror=alert(1)>' } } });
  refused({ objects: [], meshes: { m: { ...mesh, w: 100000 } } });
});

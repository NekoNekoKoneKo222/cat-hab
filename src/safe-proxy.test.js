'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateUrl, fetchSafe, publicIPv4 } = require('./safe-proxy');

test('rejects local and reserved IPv4 ranges', () => {
  for (const ip of ['127.0.0.1','10.2.3.4','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0']) assert.equal(publicIPv4(ip), false);
  assert.equal(publicIPv4('8.8.8.8'), true);
});
test('rejects protocols, credentials, local names and DNS answers', async () => {
  const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
  for (const url of ['file:///etc/passwd','http://localhost/','http://user:pass@example.com/','http://example.com:5432/','http://[::1]/']) {
    await assert.rejects(validateUrl(url, lookup));
  }
  await assert.rejects(validateUrl('https://example.com/', lookup));
});
test('validates every redirect and blocks unsafe content types', async () => {
  const validate = async raw => raw.includes('private') ? Promise.reject(new Error('blocked')) : ({ url: new URL(raw), address: '8.8.8.8' });
  const redirect = async () => ({ status: 302, headers: { location: 'http://private/' }, body: Buffer.alloc(0) });
  await assert.rejects(fetchSafe('https://public/', { validate, request: redirect }));
  const html = async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<script>') });
  await assert.rejects(fetchSafe('https://public/', { validate, request: html }));
});

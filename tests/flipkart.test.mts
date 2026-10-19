// Flipkart classifier, on pages shaped like the three real ones fetched on 19 Oct 2026.
import assert from 'node:assert/strict';
const { classifyFk, extractFkPrice } = await import('../lib/logic.ts');
const page = (sku: string, price: number, avail: string, extra = '') =>
  `<html><head><title>HoneyTouch</title><script type="application/ld+json">[{"@context":"http://schema.org","@type":"Product","name":"HoneyTouch bed","sku":"${sku}","offers":{"@type":"Offer","price":${price},"priceCurrency":"INR","availability":"https://schema.org/${avail}"}}]</script>${extra}</head><body><script>window.__INITIAL_STATE__={"pageDataV4":{"productId":"${sku}"}}</script> similar BDDHRYQQKSVFXGVS BDDH9HZ7QA2KR5SZ</body></html>`;

const nova = classifyFk('BDDGQ43N7BCXAEGZ', page('BDDGQ43N7BCXAEGZ', 7979, 'InStock'));
assert.equal(nova.cls, 'live'); assert.equal(nova.price, 7979); assert.equal(nova.served, 'BDDGQ43N7BCXAEGZ');
const eva = classifyFk('OSCG7UAZZJ2EQYZS', page('OSCG7UAZZJ2EQYZS', 2799, 'OutOfStock'));
assert.equal(eva.cls, 'unavailable'); assert.equal(eva.avail, 'OutOfStock');
const atlas = classifyFk('bddhrrjvbqauhzxw', page('BDDHRRJVBQAUHZXW', 5999, 'InStock'));
assert.equal(atlas.cls, 'live'); assert.equal(atlas.price, 5999);
// Flipkart opened the 2.5x6 sibling instead.
const swap = classifyFk('BDDHRRJVBQAUHZXW', page('BDDHRWFFPPZJVRXG', 5699, 'InStock'));
assert.equal(swap.cls, 'variant'); assert.equal(swap.served, 'BDDHRWFFPPZJVRXG');
assert.equal(classifyFk('BDDGQ43N7BCXAEGZ', page('BDDGQ43N7BCXAEGZ', 7979, 'PreOrder')).cls, 'nobuy');
assert.equal(classifyFk('BDDGQ43N7BCXAEGZ', page('BDDGQ43N7BCXAEGZ', 0, 'InStock')).cls, 'nobuy');
assert.equal(classifyFk('BDDGQ43N7BCXAEGZ', '<html>Are you a human?</html>').cls, 'error');
assert.equal(classifyFk('BDDGQ43N7BCXAEGZ', '').cls, 'error');
// No JSON-LD but the page state names the product.
assert.equal(classifyFk('BDDGQ43N7BCXAEGZ', '<script>{"productId":"BDDGQ43N7BCXAEGZ"}</script>').cls, 'nobuy');
// The Deal-prices tab's live price parser reads the same block.
assert.equal(extractFkPrice(page('BDDGQ43N7BCXAEGZ', 7979, 'InStock')), 7979);
console.log('flipkart tests passed');

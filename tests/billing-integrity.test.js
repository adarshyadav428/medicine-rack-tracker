const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const src = fs.readFileSync(path.join(__dirname, '..', 'billing.js'), 'utf8');
function section(a, b) { return src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a))); }
function check(label, fn) { fn(); console.log('PASS ' + label); }
const model = { customerLastPrices: {}, customerLastPricesFor: null };
const requests = [];
const context = {
  bState: model,
  bEl: { customerName: { value: 'Bob' }, customerPhone: { value: 'BOB-PHONE' }, notes: { value: 'BOB-PRIVATE' } },
  normalizeString: x => String(x || '').trim(),
  escHtml: x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  receivedAmountValue: () => 0,
  requestApi: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
};
vm.createContext(context);
vm.runInContext(section('  function lineMoney(', '  function round2(') +
  section('  function round2(', '  /**\n   * Money read') +
  section('  function numToWords(', '  async function printBill(') +
  section('  function loadCustomerLastPrices(', '  // -------------------------------------------------------------------------\n  // Medicine Search'), context);
check('fractional quantities use integer paise rounding', () => assert.equal(context.lineMoney(.67, .5), .34));
check('half paise is rounded consistently', () => assert.equal(context.lineMoney(1, 1.005), 1.01));
const receipt = context.buildReceiptHtml({ customerName: 'Alice', customerPhone: '', notes: '', billNumber: 'SAVED', createdAt: '2024-01-01T10:00:00Z', gstPercent: 0, prevBalance: 0, received: 0, items: [{ medicine_name: 'Test', quantity: 1, sell_price: 100, line_total: 100 }] });
check('saved blank phone never borrows active draft data', () => assert.equal(receipt.includes('BOB-PHONE'), false));
check('saved blank notes never borrow active draft data', () => assert.equal(receipt.includes('BOB-PRIVATE'), false));
check('saved receipt preserves issue year', () => assert.equal(receipt.includes('2024'), true));
const creditReceipt = context.buildReceiptHtml({ customerName: 'Alice', customerPhone: '', notes: '', billNumber: 'CREDIT', createdAt: '2024-01-01T10:00:00Z', gstPercent: 0, prevBalance: -50, received: 0, items: [{ medicine_name: 'Test', quantity: 1, sell_price: 100, line_total: 100 }] });
check('prior credit is explained on the printed receipt', () => assert.equal(creditReceipt.includes('Previous Credit'), true));
check('credit receipt exposes the resulting total due', () => assert.equal(creditReceipt.includes('Total Due'), true));
(async () => {
  context.loadCustomerLastPrices('Alice'); requests[0].resolve({ priceMap: { test: { sellPrice: 100 } } });
  await new Promise(r => setImmediate(r));
  context.loadCustomerLastPrices('Bob');
  check('pending Bob lookup cannot consume Alice price', () => assert.equal(model.customerLastPrices.test, undefined));
  requests[1].reject(new Error('offline')); await new Promise(r => setImmediate(r));
  context.loadCustomerLastPrices('Bob');
  check('failed price lookup is retried on reselection', () => assert.equal(requests.length, 3));
  requests[2].resolve({ priceMap: { test: { sellPrice: 200 } } }); await new Promise(r => setImmediate(r));
  check('completed lookup belongs to selected customer', () => assert.equal(model.customerLastPrices.test.sellPrice, 200));
})().catch(e => { console.error(e); process.exitCode = 1; });

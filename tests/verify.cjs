// Regression checks against the actual standalone page. No packages required.
// Usage: node tests/verify.cjs [path/to/index.html]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const pagePath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'index.html'));
const html = fs.readFileSync(pagePath, 'utf8');
const decode = value => String(value ?? '').replace(/&quot;/g, '"').replace(/&#39;|&#039;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attributes = source => {
  const result = {};
  for (const match of source.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    result[match[1]] = decode(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
};

class Element {
  constructor(tag = 'div', attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.attributes = { ...attrs };
    this.id = attrs.id || '';
    this.name = attrs.name || '';
    this.type = attrs.type || '';
    this.value = attrs.value || '';
    this.defaultValue = this.value;
    this.checked = Object.hasOwn(attrs, 'checked');
    this.defaultChecked = this.checked;
    this.hidden = Object.hasOwn(attrs, 'hidden');
    this.disabled = Object.hasOwn(attrs, 'disabled');
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.dataset = Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith('data-'))
      .map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v]));
    this.textContent = '';
    this.innerHTML = '';
    this.options = [];
    this.className = attrs.class || '';
    this.classList = {
      add: (...names) => { const s = new Set(this.className.split(/\s+/).filter(Boolean)); names.forEach(n => s.add(n)); this.className = [...s].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(n => !names.includes(n)).join(' '); },
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => { const enabled = force ?? !this.classList.contains(name); this.classList[enabled ? 'add' : 'remove'](name); return enabled; },
    };
  }
  get selectedOptions() { return this.options.filter(option => option.value === this.value); }
  get selectedIndex() { return this.options.findIndex(option => option.value === this.value); }
  set selectedIndex(index) { this.value = this.options[index]?.value || ''; }
  get validity() { return { valid: !this.validationMessage, stepMismatch: this.type === 'number' && this.value !== '' && !Number.isInteger(Number(this.value)) }; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  toggleAttribute(name, force) { const on = force ?? !Object.hasOwn(this.attributes, name); if (on) this.setAttribute(name, ''); else this.removeAttribute(name); return on; }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] || []).filter(cb => cb !== listener); }
  dispatchEvent(event) { event.target ||= this; event.currentTarget = this; for (const listener of this.listeners[event.type] || []) listener(event); return !event.defaultPrevented; }
  appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) { this.children = children.flatMap(c => c.tagName === 'FRAGMENT' ? c.children : [c]); }
  querySelectorAll(selector) { return this.children.filter(child => selector.startsWith('.') ? child.classList.contains(selector.slice(1)) : true); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest() { return this._shell ||= new Element(); }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
  scrollIntoView() {}
  focus() { document.activeElement = this; this.dispatchEvent(new TestEvent('focus')); }
  blur() { this.dispatchEvent(new TestEvent('blur')); }
  setCustomValidity(message) { this.validationMessage = message; }
  checkValidity() { return !this.validationMessage; }
  reportValidity() { return this.checkValidity(); }
}
class TestEvent {
  constructor(type, init = {}) { this.type = type; Object.assign(this, init); this.defaultPrevented = false; }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() {}
}

const elements = new Map();
const named = {};
const all = [];
for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
  const tag = match[1].toLowerCase(), attrs = attributes(match[2]);
  const element = new Element(tag, attrs);
  if (tag === 'select') {
    const body = html.slice(match.index + match[0].length).split(/<\/select\s*>/i)[0];
    for (const opt of body.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option\s*>/gi)) {
      const option = new Element('option', attributes(opt[1]));
      option.textContent = decode(opt[2].replace(/<[^>]*>/g, '')).trim();
      option.value = option.attributes.value ?? option.textContent;
      element.options.push(option);
    }
    element.value = (element.options.find(o => Object.hasOwn(o.attributes, 'selected')) || element.options[0])?.value || '';
    element.defaultValue = element.value;
  }
  if (tag === 'script') element.textContent = html.slice(match.index + match[0].length).split(/<\/script\s*>/i)[0];
  if (attrs.id) elements.set(attrs.id, element);
  if (attrs.name && ['input', 'select', 'textarea'].includes(tag)) named[attrs.name] = element;
  all.push(element);
}
const form = elements.get('scoreForm');
assert.ok(form, 'The score form must exist');
form.elements = named;
form.reset = () => { for (const element of Object.values(named)) { element.value = element.defaultValue; element.checked = element.defaultChecked; element.validationMessage = ''; } };
const document = {
  activeElement: null,
  body: new Element('body'),
  getElementById: id => elements.get(id) || null,
  createElement: tag => new Element(tag),
  createDocumentFragment: () => new Element('fragment'),
  addEventListener() {},
  querySelector(selector) {
    const selected = selector.match(/^#([\w-]+)\s+option:checked$/);
    if (selected) return elements.get(selected[1])?.selectedOptions[0] || null;
    if (selector.startsWith('#')) return elements.get(selector.slice(1)) || null;
    return this.querySelectorAll(selector)[0] || null;
  },
  querySelectorAll(selector) {
    if (selector === 'input, select' || selector === 'select, input') return Object.values(named);
    if (selector.startsWith('.')) return all.filter(element => element.classList.contains(selector.slice(1)));
    const attr = selector.match(/^\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
    if (attr) return all.filter(element => Object.hasOwn(element.attributes, attr[1]) && (attr[2] === undefined || element.attributes[attr[1]] === attr[2]));
    return all.filter(element => element.tagName.toLowerCase() === selector);
  },
};
const context = { document, Event: TestEvent, console, setTimeout, clearTimeout,
  requestAnimationFrame: callback => callback(), navigator: { language: 'zh-CN' } };
context.window = context;
context.globalThis = context;
context.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
vm.createContext(context);
for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
  const attrs = attributes(script[1]);
  if (attrs.src || (attrs.type && !/^(?:text\/javascript|application\/javascript|module)$/.test(attrs.type))) continue;
  vm.runInContext(script[2], context, { filename: pagePath, timeout: 5000 });
}
assert.equal(vm.runInContext('typeof compute', context), 'function', 'Page must expose compute()');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const field = name => { assert.ok(named[name], `Missing expected form field: ${name}`); return named[name]; };
const put = values => { for (const [name, value] of Object.entries(values)) { const element = field(name); if (typeof value === 'boolean') element.checked = value; else element.value = String(value); } };
const calculate = () => vm.runInContext('compute()', context, { timeout: 5000 });
const routeOf = result => typeof result.route === 'string' ? result.route : result.route?.type;
const hasFailures = result => (result.inputFailures || []).length > 0;
const eligible = result => routeOf(result) === 'nonShanghai' && result.basicPass && !hasFailures(result)
  && ((result.directReasons || []).length > 0 || result.total >= 72);
const points = (result, needle) => result.items.filter(item => item.label.includes(needle)).reduce((sum, item) => sum + item.points, 0);
const essentialChecks = ['isFresh', 'employerQualified', 'contractOneYear', 'notDispatch', 'noLaborDuringStudy', 'materialsTrue',
  'admissionRegular', 'nonDirected', 'diplomaConfirmed', 'lawful', 'fullTimeBachelor'];
function base(overrides = {}) {
  form.reset();
  put({ graduateRoute: 'nonShanghai', degree: 'bachelor', schoolInput: '10280 | 上海大学', majorInput: '0809',
    manualSchoolCategory: 'auto', computerLevel: 'none', ...Object.fromEntries(essentialChecks.map(name => [name, true])), ...overrides });
  return calculate();
}

test('Shanghai graduates receive a separate route without the 72-point conclusion', () => {
  const result = base({ graduateRoute: 'shanghai' });
  assert.equal(routeOf(result), 'shanghai');
  assert.equal(result.total, 0);
  assert.equal(result.directReasons.length, 0);
  assert.ok(!(result.basicFailures || []).some(x => /非上海生源/.test(typeof x === 'string' ? x : JSON.stringify(x))));
  assert.equal(eligible(result), false);
});
test('Overseas graduates do not use the domestic graduate score', () => {
  const result = base({ graduateRoute: 'overseas', honorLevel: '10', contestLevel: '10' });
  assert.equal(routeOf(result), 'overseas');
  assert.equal(result.total, 0);
  assert.equal(result.directReasons.length, 0);
  assert.equal(eligible(result), false);
});
test('An unconfirmed graduate route cannot qualify', () => {
  for (const route of ['', 'unsure']) {
    const result = base({ graduateRoute: route, degree: 'doctor' });
    assert.equal(eligible(result), false, `route=${route}`);
  }
});
test('School code alone and a selected full school label have equal scores and routes', () => {
  const code = base({ schoolInput: '10280' });
  const selected = base({ schoolInput: '10280 | 上海大学' });
  assert.equal(code.total, selected.total);
  assert.deepEqual(Array.from(code.directReasons), Array.from(selected.directReasons));
  assert.equal(points(code, '在沪学习'), 2);
  assert.equal(hasFailures(code), false);
});
test('Known school codes remain recognizable when policy lists contain name aliases', () => {
  for (const [code, name] of [['10023', '北京协和医学院'], ['10425', '中国石油大学（华东）'],
    ['10491', '中国地质大学（武汉）'], ['11413', '中国矿业大学（北京）'],
    ['10054', '华北电力大学'], ['10079', '华北电力大学']]) {
    const byCode = base({ schoolInput: code });
    const byLabel = base({ schoolInput: `${code} | ${name}` });
    assert.equal(hasFailures(byCode), false, code);
    assert.equal(byCode.total, byLabel.total, code);
  }
});
test('Ambiguous and invented school names never grant a direct route', () => {
  for (const school of ['大学', '上海', '北京大学不存在']) {
    const result = base({ schoolInput: school });
    assert.equal(result.directReasons.length, 0, school);
    assert.equal(eligible(result), false, school);
  }
});
test('An undergraduate major cannot become a graduate discipline with the same code', () => {
  const result = base({ degree: 'master', schoolInput: '10293 | 南京邮电大学',
    majorInput: '0809 | 计算机类（本科/专科专业类）' });
  assert.equal(result.directReasons.length, 0);
  assert.equal(points(result, '重点领域'), 0);
});
test('Unlisted undergraduate categories cannot borrow graduate discipline points', () => {
  for (const major of ['0812 | 测绘类（本科/专科专业类）', '0810 | 土木类（本科/专科专业类）']) {
    const result = base({ majorInput: major });
    assert.equal(points(result, '重点领域'), 0, major);
  }
});
test('A broad graduate discipline does not inherit a listed narrow subdiscipline', () => {
  const result = base({ degree: 'master', schoolInput: '10004 | 北京交通大学', majorInput: '0401 | 教育学' });
  assert.equal(points(result, '重点领域'), 0);
});
test('Listed individual undergraduate majors receive six points by code', () => {
  for (const major of ['050306', '040107', '040108']) {
    const result = base({ majorInput: major });
    assert.equal(points(result, '重点领域'), 6, major);
  }
});
test('The letter-bearing undergraduate trial-class code is recognized', () => {
  assert.equal(points(base({ majorInput: '02SY' }), '重点领域'), 6);
});
test('Malformed short or long professional codes do not become a valid discipline', () => {
  for (const major of ['08121', '08129999']) {
    const result = base({ degree: 'master', schoolInput: '10013 | 北京邮电大学', majorInput: major });
    assert.equal(result.directReasons.length, 0, major);
    assert.equal(points(result, '重点领域'), 0, major);
  }
});
test('Accurate graduate discipline names agree with selected code labels', () => {
  const byName = base({ degree: 'master', schoolInput: '10053 | 中国政法大学', majorInput: '法学' });
  const byLabel = base({ degree: 'master', schoolInput: '10053 | 中国政法大学', majorInput: '0301 | 法学（研究生学科）' });
  assert.ok(byName.directReasons.length > 0);
  assert.equal(byName.total, byLabel.total);
  assert.deepEqual(Array.from(byName.directReasons), Array.from(byLabel.directReasons));
});
test('Missing degree prevents a score-based success even with enough bonus points', () => {
  const result = base({ degree: '', rankLevel: '8', languageLevel: '8', computerLevel: 'artsIntermediate',
    honorLevel: '10', contestLevel: '10', majorInput: '0812', employerIntegrity: true,
    patent: true, majorProject: true, keyRegionPublic: true, remotePublic: true, teacherRole: true, startup: true });
  assert.equal(eligible(result), false);
  assert.ok(hasFailures(result) || !result.basicPass);
});
test('Fractional honor counts do not create fractional score points', () => {
  const ordinary = base({ schoolHonorCount: '0' });
  const fractional = base({ schoolHonorCount: '0.5' });
  assert.equal(points(fractional, '荣誉'), 0);
  assert.equal(fractional.total, ordinary.total);
  assert.ok(hasFailures(fractional));
});
test('Valid school honors remain capped at two and honors plus contests at fifteen', () => {
  assert.equal(points(base({ schoolHonorCount: '3' }), '荣誉'), 2);
  assert.equal(points(base({ honorLevel: '10', contestLevel: '10' }), '荣誉'), 15);
});
test('Bachelor direct routes require every applicable confirmation', () => {
  const confirmed = base({ schoolInput: '10246 | 复旦大学' });
  assert.ok(eligible(confirmed));
  for (const check of ['admissionRegular', 'nonDirected', 'diplomaConfirmed', 'lawful', 'fullTimeBachelor']) {
    const result = base({ schoolInput: '10246 | 复旦大学', [check]: false });
    assert.equal(eligible(result), false, check);
  }
});
test('Master direct routes require the applicable admission and diploma confirmations', () => {
  assert.ok(eligible(base({ degree: 'master', majorInput: '0812' })));
  for (const check of ['admissionRegular', 'nonDirected', 'diplomaConfirmed', 'lawful']) {
    const result = base({ degree: 'master', majorInput: '0812', [check]: false });
    assert.equal(eligible(result), false, check);
  }
});
test('Doctor direct routes do not require a school-list match or an entered major', () => {
  for (const [school, major] of [['', ''], ['名单外博士培养单位', '名单外博士专业']]) {
    const result = base({ degree: 'doctor', schoolInput: school, majorInput: major });
    assert.ok(eligible(result), `${school || '(blank school)'} / ${major || '(blank major)'}`);
    assert.ok(result.directReasons.some(reason => /博士/.test(reason)));
  }
  assert.equal(eligible(base({ degree: 'doctor', schoolInput: '', majorInput: '', diplomaConfirmed: false })), false);
});
test('School-based master direct routes do not require a major', () => {
  for (const school of ['10280 | 上海大学', '10001 | 北京大学']) {
    const result = base({ degree: 'master', schoolInput: school, majorInput: '' });
    assert.ok(eligible(result), school);
    assert.ok(result.directReasons.length > 0, school);
    assert.equal(eligible(base({ degree: 'master', schoolInput: school, majorInput: '', lawful: false })), false, school);
  }
});
test('Other master applicants still need the major used to determine their discipline or score', () => {
  const result = base({ degree: 'master', schoolInput: '10004 | 北京交通大学', majorInput: '' });
  assert.equal(eligible(result), false);
  assert.ok(hasFailures(result));
});
test('The regional bachelor route requires regional recognition', () => {
  const pending = base({ keyRegionEmployer: true, keyRegionRecognized: false });
  assert.equal(pending.directReasons.length, 0);
  const confirmed = base({ keyRegionEmployer: true, keyRegionRecognized: true });
  assert.ok(confirmed.directReasons.length > 0);
});
test('Graduate computer exemption is unavailable to bachelor graduates', () => {
  const result = base({ computerLevel: 'graduate' });
  assert.equal(points(result, '计算机'), 0);
  assert.ok(hasFailures(result) || !result.basicPass);
});
test('Every distinct computer qualification uses the correct point value', () => {
  for (const [value, expected] of [['none', 0], ['scienceAdvanced', 7], ['artsIntermediate', 7],
    ['scienceIntermediate', 6], ['artsElementary', 6], ['artSport', 6]]) {
    assert.equal(points(base({ computerLevel: value }), '计算机'), expected, value);
  }
  assert.equal(points(base({ degree: 'master', majorInput: '0812', computerLevel: 'graduate' }), '计算机'), 7);
});
test('West Plan service is explained for separate verification, without adding five points', () => {
  const ordinary = base();
  const service = base({ westPlan: true });
  assert.equal(service.total, ordinary.total);
  assert.ok(service.notes.some(note => /西部|就业项目/.test(JSON.stringify(note))));
  assert.equal(eligible(service), false);
});
test('The bachelor sample uses undergraduate majors and computer qualifications', () => {
  form.reset();
  elements.get('sampleBachelor').dispatchEvent(new TestEvent('click'));
  assert.equal(field('degree').value, 'bachelor');
  assert.ok(!/研究生学科|研究生专业/.test(field('majorInput').value));
  assert.notEqual(field('computerLevel').value, 'graduate');
  assert.equal(routeOf(calculate()), 'nonShanghai');
  assert.equal(hasFailures(calculate()), false);
});
test('Rendering non-scoring routes never shows a score or qualification failure', () => {
  for (const route of ['shanghai', 'overseas']) {
    base({ graduateRoute: route });
    vm.runInContext('render()', context);
    assert.equal(elements.get('scoringFields').hidden, true);
    assert.ok(!/暂未达到|待核验|不符合|失败/.test(elements.get('statusText').textContent), route);
    assert.ok(!/标准分|当前试算/.test(elements.get('scoreText').innerHTML), route);
    assert.equal(elements.get('scoreMeter').style.width, '0%');
  }
});
test('A high numeric score with an unconfirmed basic condition renders as pending', () => {
  base({ schoolInput: '10246 | 复旦大学', rankLevel: '8', languageLevel: '8', computerLevel: 'scienceAdvanced',
    honorLevel: '10', contestLevel: '10', employerIntegrity: true, diplomaConfirmed: false });
  const result = calculate();
  assert.ok(result.total >= 72);
  vm.runInContext('render()', context);
  assert.ok(!elements.get('resultMain').classList.contains('ok'));
  assert.ok(!elements.get('resultMain').classList.contains('direct'));
  assert.match(elements.get('statusText').textContent, /待核验/);
});

let failed = 0;
for (const { name, fn } of tests) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n  ${error.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} checks passed: ${pagePath}`);
process.exitCode = failed ? 1 : 0;


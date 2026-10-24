/** Facts as integer columns. Every term (node, role, concept, literal, source,
 * fragment, guard, rule) is numbered once; a fact is its subject, role and
 * object numbers; its proofs, its own first and then its alternatives, are a
 * linked run of rows whose lists (sources, fragments, guards, bindings,
 * premises as fact positions) are runs of shared pools. Derivation trees and
 * any field not listed here stay beside the columns as they are.
 *
 * A fact read back (fact(f)) is the object it was made from, field for field
 * and in its key order (each object's keys are kept as an interned shape), so
 * what is serialized from it does not change. The store is what a lean base
 * holds instead of objects: tens of bytes a fact rather than kilobytes.
 */

export const NONE = 0xffffffff;
const listFields = ['sourceIds', 'fragmentIds', 'guards', 'bindingIds'];
const columnFields = new Set([...listFields, 'ruleId', 'premises', 'derivation']);
const factFields = new Set(['id', 'triple', 'alternatives']);

class Column {
  constructor(capacity = 1024) {
    this.data = new Uint32Array(capacity);
    this.length = 0;
  }
  push(value) {
    if (this.length === this.data.length) {
      const grown = new Uint32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.length++] = value;
    return this.length - 1;
  }
  get bytes() {
    return this.data.byteLength;
  }
}

export class FactStore {
  constructor() {
    this.numbers = new Map();
    this.terms = [];
    this.s = new Column();
    this.r = new Column();
    this.o = new Column();
    this.firstProof = new Column();
    this.lastProof = new Column();
    this.factShape = new Column();
    // A fact whose id is not its triple's key keeps it here.
    this.ids = new Map();
    this.positions = new Map();
    this.proofFact = new Column();
    this.proofNext = new Column();
    this.proofShape = new Column();
    this.proofRule = new Column();
    this.premiseStart = new Column();
    this.premiseCount = new Column();
    this.premises = new Column();
    this.lists = Object.fromEntries(
      listFields.map((field) => [
        field,
        { start: new Column(), count: new Column(), pool: new Column() },
      ]),
    );
    this.derivations = new Map();
    this.extras = new Map();
    this.shapes = [];
    this.shapeNumbers = new Map();
  }
  get length() {
    return this.s.length;
  }
  term(value) {
    let n = this.numbers.get(value);
    if (n === undefined) {
      n = this.terms.length;
      this.numbers.set(value, n);
      this.terms.push(value);
    }
    return n;
  }
  shape(keys) {
    const key = keys.join('\u0000');
    let n = this.shapeNumbers.get(key);
    if (n === undefined) {
      n = this.shapes.length;
      this.shapeNumbers.set(key, n);
      this.shapes.push(keys);
    }
    return n;
  }
  position(id) {
    return this.positions.get(id);
  }
  /** Append a proof row for a fact; its first is the fact's own. */
  addProof(f, proof, own = false) {
    const p = this.proofFact.push(f);
    this.proofNext.push(NONE);
    let keys = Object.keys(proof);
    if (own) keys = keys.filter((key) => !factFields.has(key));
    this.proofShape.push(this.shape(keys));
    this.proofRule.push(proof.ruleId === undefined ? NONE : this.term(proof.ruleId));
    for (const field of listFields) {
      const list = this.lists[field];
      const values = proof[field];
      list.start.push(list.pool.length);
      list.count.push(values ? values.length : 0);
      if (values) for (const value of values) list.pool.push(this.term(value));
    }
    const premises = proof.premises ?? [];
    this.premiseStart.push(this.premises.length);
    this.premiseCount.push(premises.length);
    for (const id of premises) {
      const q = this.positions.get(id);
      if (q === undefined) throw new Error('A premise is not in the store');
      this.premises.push(q);
    }
    if (proof.derivation !== undefined) this.derivations.set(p, proof.derivation);
    const extra = keys.filter((key) => !columnFields.has(key));
    if (extra.length) this.extras.set(p, Object.fromEntries(extra.map((key) => [key, proof[key]])));
    if (this.firstProof.data[f] === NONE) this.firstProof.data[f] = p;
    else this.proofNext.data[this.lastProof.data[f]] = p;
    this.lastProof.data[f] = p;
    return p;
  }
  /** Append a fact object (its own proof, then its alternatives). */
  add(fact) {
    const f = this.addFact(fact);
    this.addProofs(f, fact);
    return f;
  }
  /** A fact's identity alone; its proofs follow with addProofs. */
  addFact(fact) {
    const f = this.s.push(this.term(fact.triple[0]));
    this.r.push(this.term(fact.triple[1]));
    this.o.push(this.term(fact.triple[2]));
    this.firstProof.push(NONE);
    this.lastProof.push(NONE);
    const keys = Object.keys(fact);
    this.factShape.push(this.shape(keys));
    const own = JSON.stringify(fact.triple),
      id = fact.id ?? own;
    if (id !== own) this.ids.set(f, id);
    this.positions.set(id, f);
    return f;
  }
  addProofs(f, fact) {
    this.addProof(f, fact, true);
    for (const alternative of fact.alternatives ?? []) this.addProof(f, alternative);
  }
  /** A proof found later for a fact already held, as `(fact.alternatives ??=
   * []).push(proof)` adds it: the fact gains the key last if it had none. */
  addAlternative(f, proof) {
    const keys = this.shapes[this.factShape.data[f]];
    if (!keys.includes('alternatives'))
      this.factShape.data[f] = this.shape([...keys, 'alternatives']);
    return this.addProof(f, proof);
  }
  /** Facts in their order; a proof may rest on a fact that comes after it. */
  static from(facts) {
    const store = new FactStore();
    const positions = facts.map((fact) => store.addFact(fact));
    facts.forEach((fact, i) => store.addProofs(positions[i], fact));
    return store;
  }
  triple(f) {
    return [this.terms[this.s.data[f]], this.terms[this.r.data[f]], this.terms[this.o.data[f]]];
  }
  id(f) {
    return this.ids.get(f) ?? JSON.stringify(this.triple(f));
  }
  /** One proof row as its fields. */
  proofField(p, key) {
    if (key === 'ruleId') return this.terms[this.proofRule.data[p]];
    if (key === 'premises') {
      const start = this.premiseStart.data[p];
      return Array.from({ length: this.premiseCount.data[p] }, (_, i) =>
        this.id(this.premises.data[start + i]),
      );
    }
    if (key === 'derivation') return this.derivations.get(p);
    const list = this.lists[key];
    if (list) {
      const start = list.start.data[p];
      return Array.from(
        { length: list.count.data[p] },
        (_, i) => this.terms[list.pool.data[start + i]],
      );
    }
    return this.extras.get(p)?.[key];
  }
  /** A list field of a proof row as term numbers. */
  listRun(field, p) {
    const list = this.lists[field],
      start = list.start.data[p];
    return list.pool.data.subarray(start, start + list.count.data[p]);
  }
  /** Whether a proof row's guards are all among the witnesses (fact ids). */
  guardsHeld(p, witnesses) {
    const guards = this.listRun('guards', p);
    for (let i = 0; i < guards.length; i++) if (!witnesses.has(this.terms[guards[i]])) return false;
    return true;
  }
  /** The same, with the witnesses as fact positions. */
  guardsHeldAt(p, positions) {
    const guards = this.listRun('guards', p);
    for (let i = 0; i < guards.length; i++) {
      const f = this.positions.get(this.terms[guards[i]]);
      if (f === undefined || !positions.has(f)) return false;
    }
    return true;
  }
  /** Whether a fact has a proof whose guards the witnesses hold. */
  guarded(f, witnesses) {
    for (let p = this.firstProof.data[f]; p !== NONE; p = this.proofNext.data[p])
      if (this.guardsHeld(p, witnesses)) return true;
    return false;
  }
  proofs(f) {
    const rows = [];
    for (let p = this.firstProof.data[f]; p !== NONE; p = this.proofNext.data[p]) rows.push(p);
    return rows;
  }
  proof(p) {
    return Object.fromEntries(
      this.shapes[this.proofShape.data[p]].map((key) => [key, this.proofField(p, key)]),
    );
  }
  /** The fact object, as it was added. */
  fact(f) {
    const [own, ...alternatives] = this.proofs(f);
    return Object.fromEntries(
      this.shapes[this.factShape.data[f]].map((key) => [
        key,
        key === 'id'
          ? this.id(f)
          : key === 'triple'
            ? this.triple(f)
            : key === 'alternatives'
              ? alternatives.map((p) => this.proof(p))
              : this.proofField(own, key),
      ]),
    );
  }
  facts() {
    return Array.from({ length: this.length }, (_, f) => this.fact(f));
  }
  /** Bytes held in typed arrays, and an estimate for the term strings. */
  get bytes() {
    const columns = [
      this.s,
      this.r,
      this.o,
      this.firstProof,
      this.lastProof,
      this.factShape,
      this.proofFact,
      this.proofNext,
      this.proofShape,
      this.proofRule,
      this.premiseStart,
      this.premiseCount,
      this.premises,
      ...Object.values(this.lists).flatMap((list) => [list.start, list.count, list.pool]),
    ].reduce((sum, column) => sum + column.length * 4, 0);
    const strings = this.terms.reduce((sum, term) => sum + String(term).length + 16, 0);
    return { columns, strings };
  }
}

// Arrays that are a store's first facts, in order: inference's cohorts and
// its result. The matcher reads their terms from the store's columns instead
// of numbering them again. A changed array (length or last fact) is not one.
const prefixes = new WeakMap();
export function storePrefix(facts, store) {
  if (
    facts.length > store.length ||
    (facts.length && store.id(facts.length - 1) !== facts.at(-1).id)
  )
    throw new Error('Not a prefix of the store');
  prefixes.set(facts, { store, length: facts.length, last: facts.at(-1) });
  return facts;
}
export function storeOf(facts) {
  const prefix = prefixes.get(facts);
  return prefix && prefix.length === facts.length && prefix.last === facts.at(-1)
    ? prefix.store
    : null;
}

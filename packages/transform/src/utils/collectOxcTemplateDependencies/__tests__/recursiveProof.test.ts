import * as recursiveProof from '../recursiveProof';

describe('recursiveProof', () => {
  it('isolates partial proofs from the completed cache', () => {
    const node = {};
    const state = recursiveProof.create<object>();
    let proofRuns = 0;

    expect(
      recursiveProof.run(node, state, () => {
        proofRuns += 1;
        return true;
      })
    ).toBe(true);
    expect(
      recursiveProof.run(node, recursiveProof.partial(state), () => {
        proofRuns += 1;
        return false;
      })
    ).toBe(false);
    expect(recursiveProof.run(node, state, () => false)).toBe(true);
    expect(proofRuns).toBe(2);
  });

  it('caches a completed false proof', () => {
    const node = {};
    const state = recursiveProof.create<object>();
    let proofRuns = 0;

    expect(
      recursiveProof.run(node, state, () => {
        proofRuns += 1;
        return false;
      })
    ).toBe(false);
    expect(recursiveProof.run(node, state, () => true)).toBe(false);
    expect(proofRuns).toBe(1);
  });

  it('leaves every active ancestor uncacheable after a cycle', () => {
    const first = {};
    const second = {};
    const state = recursiveProof.create<object>();
    let firstRuns = 0;
    let secondRuns = 0;

    expect(
      recursiveProof.run(first, state, () => {
        firstRuns += 1;
        return recursiveProof.run(second, state, () => {
          secondRuns += 1;
          return recursiveProof.run(first, state, () => true);
        });
      })
    ).toBe(false);
    expect(
      recursiveProof.run(first, state, () => {
        firstRuns += 1;
        return true;
      })
    ).toBe(true);
    expect(
      recursiveProof.run(second, state, () => {
        secondRuns += 1;
        return true;
      })
    ).toBe(true);
    expect({ firstRuns, secondRuns }).toEqual({
      firstRuns: 2,
      secondRuns: 2,
    });
  });

  it('cleans the active stack when a proof throws', () => {
    const node = {};
    const state = recursiveProof.create<object>();

    expect(() =>
      recursiveProof.run(node, state, () => {
        throw new Error('proof failed');
      })
    ).toThrow('proof failed');
    expect(recursiveProof.run(node, state, () => true)).toBe(true);
  });
});

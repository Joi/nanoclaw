# Intake Routing Decision Functions — Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.
> 
> **All code lives on jibotmac** — execute all commands via `ssh jibotmac 'cd ~/nanoclaw && ...'`

**Goal:** Add pure decision functions that determine whether to run intake and whether to route to the agent, based on channel mode (listening vs available).

**Architecture:** Two pure exported functions (`shouldRunIntake`, `shouldRouteToAgent`) and one type alias (`ChannelMode`) in a single new file. No imports, no side effects — just boolean logic that downstream callers will use to branch on channel mode. Undefined channel mode defaults to `'listening'`.

**Tech Stack:** TypeScript (ES2022 target, NodeNext modules), Vitest

**Spec Review Warning:** The spec review loop exhausted after 3 iterations during the initial implementation attempt. The final verdict was APPROVED, but the process required a remediation commit (`ecec988`) to fix a signature mismatch (3-param vs 2-param `shouldRunIntake`). Human reviewer should verify the implementation matches the spec exactly.

---

### Task 1: Write failing tests for `shouldRunIntake`

**Files:**
- Create: `src/intake-routing.test.ts`

**Step 1: Write the test file**

```typescript
// src/intake-routing.test.ts
import { describe, it, expect } from 'vitest';

import { shouldRunIntake, shouldRouteToAgent } from './intake-routing.js';

describe('shouldRunIntake', () => {
  it('returns true in listening mode when not mentioned', () => {
    expect(shouldRunIntake('listening', false)).toBe(true);
  });

  it('returns true in listening mode when mentioned', () => {
    expect(shouldRunIntake('listening', true)).toBe(true);
  });

  it('returns false in available mode when not explicitly commanded', () => {
    expect(shouldRunIntake('available', false)).toBe(false);
  });

  it('returns true in available mode when explicitly commanded', () => {
    expect(shouldRunIntake('available', true)).toBe(true);
  });

  it('defaults to listening when channelMode is undefined', () => {
    expect(shouldRunIntake(undefined, false)).toBe(true);
    expect(shouldRunIntake(undefined, true)).toBe(true);
  });
});
```

Note: Import uses `.js` extension — this project uses `"module": "NodeNext"` in tsconfig, which requires `.js` extensions in import paths even for `.ts` source files.

**Step 2: Run test to verify it fails**

```bash
ssh jibotmac 'cd ~/nanoclaw && npx vitest run src/intake-routing.test.ts'
```

Expected: FAIL — `Cannot find module './intake-routing.js'` (file doesn't exist yet)

---

### Task 2: Write failing tests for `shouldRouteToAgent`

**Files:**
- Modify: `src/intake-routing.test.ts`

**Step 1: Append `shouldRouteToAgent` tests to the same file**

Add below the `shouldRunIntake` describe block:

```typescript
describe('shouldRouteToAgent', () => {
  it('routes to agent when bot is mentioned (any mode)', () => {
    expect(shouldRouteToAgent('listening', true, false)).toBe(true);
    expect(shouldRouteToAgent('available', true, false)).toBe(true);
  });

  it('routes to agent for DMs (any mode)', () => {
    expect(shouldRouteToAgent('listening', false, true)).toBe(true);
    expect(shouldRouteToAgent('available', false, true)).toBe(true);
  });

  it('does NOT route to agent for non-mention channel messages', () => {
    expect(shouldRouteToAgent('listening', false, false)).toBe(false);
    expect(shouldRouteToAgent('available', false, false)).toBe(false);
  });

  it('defaults to listening when channelMode is undefined', () => {
    expect(shouldRouteToAgent(undefined, true, false)).toBe(true);
    expect(shouldRouteToAgent(undefined, false, false)).toBe(false);
  });
});
```

Total test count: 9 tests across 2 describe blocks.

**Step 2: Run tests to verify they fail**

```bash
ssh jibotmac 'cd ~/nanoclaw && npx vitest run src/intake-routing.test.ts'
```

Expected: FAIL — still no implementation file

**Step 3: Commit test file**

```bash
ssh jibotmac 'cd ~/nanoclaw && git add src/intake-routing.test.ts && git commit -m "test: add intake routing decision logic tests"'
```

---

### Task 3: Implement `intake-routing.ts`

**Files:**
- Create: `src/intake-routing.ts`

**Step 1: Write the implementation**

```typescript
// src/intake-routing.ts
export type ChannelMode = 'listening' | 'available' | undefined;

export function shouldRunIntake(
  channelMode: ChannelMode,
  explicitIntakeCommand: boolean,
): boolean {
  const mode = channelMode ?? 'listening';
  if (mode === 'listening') {
    return true;
  }
  // available mode
  return explicitIntakeCommand;
}

export function shouldRouteToAgent(
  _channelMode: ChannelMode,
  botMentioned: boolean,
  isDm: boolean,
): boolean {
  return botMentioned || isDm;
}
```

Key design notes for the implementer:
- `ChannelMode` includes `undefined` in the union — callers that haven't configured a mode get listening behavior by default via `??`
- `shouldRunIntake`: listening mode **always** runs intake (returns `true` regardless of `explicitIntakeCommand`); available mode only runs intake when explicitly commanded
- `shouldRouteToAgent`: channel mode is unused (`_channelMode` prefix convention) — both modes route identically on `botMentioned || isDm`
- Pure functions. Zero imports. No state.

**Step 2: Run tests to verify all 9 pass**

```bash
ssh jibotmac 'cd ~/nanoclaw && npx vitest run src/intake-routing.test.ts'
```

Expected: 9 passed (9)

**Step 3: Run TypeScript type check**

```bash
ssh jibotmac 'cd ~/nanoclaw && npx tsc --noEmit'
```

Expected: clean exit (no output, exit code 0)

**Step 4: Commit implementation**

```bash
ssh jibotmac 'cd ~/nanoclaw && git add src/intake-routing.ts && git commit -m "feat: add intake routing decision functions (listening vs available mode)"'
```

---

### Verification Checklist

After all tasks complete, run:

```bash
# All 9 tests pass
ssh jibotmac 'cd ~/nanoclaw && npx vitest run src/intake-routing.test.ts'

# Clean TypeScript build
ssh jibotmac 'cd ~/nanoclaw && npx tsc --noEmit'

# Verify commit exists
ssh jibotmac 'cd ~/nanoclaw && git log --oneline -3'
```

Expected commit message: `feat: add intake routing decision functions (listening vs available mode)`

---

### Spec Review Notes (Human Reviewer)

> **WARNING: Spec review loop exhausted after 3 iterations.**
>
> The initial implementation attempt had a signature mismatch: `shouldRunIntake` was initially written with 3 parameters (including an unused `botMentioned`) instead of the spec's 2-parameter signature `(channelMode, explicitIntakeCommand)`. This required a follow-up fix commit to align the implementation and update test call sites.
>
> The final verdict was **APPROVED** — all 9 tests pass, TypeScript builds clean, and both functions match the spec exactly. However, the iteration history suggests the spec or task description may have been ambiguous about the `shouldRunIntake` parameter list. The human reviewer should verify:
>
> 1. `shouldRunIntake` takes exactly 2 params: `(channelMode, explicitIntakeCommand)`
> 2. `shouldRouteToAgent` takes exactly 3 params: `(channelMode, botMentioned, isDm)`
> 3. The test file (`src/intake-routing.test.ts`) was modified beyond the spec's `files` list to fix call sites — this is expected remediation, not scope creep

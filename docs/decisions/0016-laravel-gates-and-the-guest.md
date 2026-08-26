# 0016 — Authorization defaults off, because of a Laravel signature trap

**Status:** accepted, 2026-08-25

Found by the `prism-workspace` agent, while writing a correction. It reached
for a supporting argument, noticed the argument was something it "knew from
making its own tests pass", and pinned it with a test rather than asserting it
— in a fix that was itself about having published an unverified claim.

## The trap

**Laravel only invokes a Gate callback for an unauthenticated user when the
callback's first parameter is explicitly nullable.**

```php
Gate::define('workspace.write', fn ($user, $workspace, $path) => …);   // never runs for a guest
Gate::define('workspace.write', fn (?User $user, $workspace, $path) => …);  // runs
```

The first signature is the natural one. Nearly everybody writes it. For a
request with no authenticated user, Laravel does not call it — it **denies**.

## Why this matters more here than in an ordinary application

An agentic package does its work where there is frequently no authenticated
user: a queue worker, a scheduled run, an unattended agent loop. Those are not
edge cases in this ecosystem; several of them are the primary use.

So an authorization check that defaults **on** ships a silent, total denial to
every consumer who wrote the natural callback signature — and the symptom is
"the agent stopped doing anything", with a gate that looks correctly defined
and never ran.

## The decision

**Authorization in satellite packages is off until the application opts in.**

- `prism-workspace` set this precedent, and the reasoning is now here rather
  than in one package's README.
- Ability names belong to the package that defines them
  ([0010](0010-package-naming-conventions.md)), with a configurable prefix.
- A package documenting its abilities should show the **nullable** signature,
  because the natural one is the broken one.

## The wider point

This is a case where the framework's behaviour is correct, documented, and
still a trap — because the safe-looking default and the natural-looking
signature combine into a silent failure.

Worth carrying into any package here that guards an operation: ask what your
check does when there is nobody to check.

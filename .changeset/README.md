# Changesets

Every user-visible change to a publishable package should include a changeset.
Choose the smallest semver impact that accurately describes the public change.

Phase 0 packages remain private while their contracts are being established,
so no initial changeset is required. Packages become publishable only as part
of an explicit release-readiness change.

Run `pnpm changeset` to create an entry. Release versioning and publication are
introduced with the alpha release automation after packed-package validation
exists.

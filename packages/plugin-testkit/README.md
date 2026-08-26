# `@localhost2137/plugin-testkit`

Framework-neutral contract cases for localhost2137 plugins. Register the returned 18 named cases
with any test runner, or execute them serially with `runPluginContract`.

The fixture declares inputs and expected data. The testkit owns runtime and instance creation,
operation execution, control introspection, local HTTP delivery, daemon restarts, assertions, and
failure-safe cleanup. Before configuration, it creates a frozen resource descriptor containing the
owned delivery URL and passes that descriptor to the selected-plugin harness. Operation inputs stay
declarative. HTTP fixture callbacks may only build a request descriptor from the selected
connection and normalize a semantic response body; the testkit performs the requests and
assertions.

## Selected-plugin harness

Keep one development-only harness beside the plugin. Every base, fault, and historical-version
variant must call the same production plugin factory, retain the same plugin ID, service key, and
public operation inventory, and vary behavior only through injected dependencies or lifecycle
version configuration. Fault variants alter existing operations or hooks; they do not add test-only
operations to the production surface.

Every successfully booted variant is checked through public control introspection for the exact
selected service key, plugin ID, state version, and operation inventory before its scenario runs.
The invalid config, invalid seed, failed-create, failed-update, and future-version downgrade paths
can fail before introspection and therefore remain a documented harness trust boundary. Identity is
nominal rather than cryptographic: a dishonest harness can reproduce an ID and inventory while
substituting another implementation. Review must ensure the harness really calls the production
factory, uses the supplied resource descriptor only as production configuration, and exposes no
test-only operation or response field. The two-instance HTTP scenario must arrange distinct state
through selected production operations and observe it through a public route.

## Child-process checks

The authoring case imports the declared file URL in a fresh bounded child, validates its named config
export, and compares cwd, environment, cwd files, and Node-reported active resources before and after
import. Stdout and stderr are independently required to stay empty, while the result travels over
IPC. From the first output byte, each stream retains only a byte count and a 256-byte diagnostic
sample, terminates the child, and never includes the sample in assertion text. Child termination has
its own deadline, and the temporary cwd is always cleaned up. This operational check cannot detect
effects that are completely reversed before the second snapshot, short-lived detached work,
concealed external-system writes, or resources Node does not report.

Durability uses the declared CLI config module and a testkit-owned process, free port, storage root,
descriptor, control token, deadline, and cleanup. The module reads these standardized environment
variables and builds the same plugin-family variant:

- `LOCALHOST2137_CONTRACT_STORAGE`
- `LOCALHOST2137_CONTRACT_EVENTS`
- `LOCALHOST2137_CONTRACT_DELIVERY_URL`
- `LOCALHOST2137_CONTRACT_VERSION`
- `LOCALHOST2137_CONTRACT_FAIL_UPDATE`

The runner resolves `localhost2137/package.json` through package exports, validates that
`bin.localhost` remains inside the installed package root, and imports that file inside a shipped
testkit supervisor after validating the fixed CLI argument shape. The supervisor is the daemon
process, so its child PID must equal the runtime descriptor PID. Cleanup sends one private IPC
shutdown message; the supervisor emits `SIGINT` inside its own process so the existing CLI cleanup
path runs consistently across operating systems. Exit and active-file/lock removal are bounded,
with `SIGKILL` sent only to that exact child as a fallback. No control token crosses IPC or argv, and
daemon output and control tokens are never included in assertion failures.

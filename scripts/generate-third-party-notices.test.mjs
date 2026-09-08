import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
    generateNotices,
    runtimeRustPackages,
    writeNotices,
} from "./generate-third-party-notices.mjs";

function write(root, file, text) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
}

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), "mora-notices-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    write(
        root,
        "package-lock.json",
        JSON.stringify({
            packages: {
                "": { name: "mora", version: "1.0.0" },
                "node_modules/runtime": { version: "1.2.3", license: "MIT" },
                "node_modules/development": {
                    version: "1.0.0",
                    dev: true,
                    license: "MIT",
                },
            },
        }),
    );
    write(
        root,
        "node_modules/runtime/package.json",
        JSON.stringify({ name: "runtime", version: "1.2.3", license: "MIT" }),
    );
    write(
        root,
        "node_modules/runtime/LICENSE",
        "Copyright Existing Author\nOriginal runtime license text.\n",
    );
    write(root, "src-tauri/Cargo.lock", "locked dependency versions\n");
    write(
        root,
        "third-party-license-sources/index.json",
        JSON.stringify({ version: 1, packages: {} }),
    );
    const metadata = {
        resolve: { root: "app", nodes: [{ id: "app", deps: [] }] },
        packages: [],
    };
    return { root, metadata, target: "x86_64-pc-windows-msvc" };
}

test("preserves original runtime and embedded-font notices while excluding dev-only packages", (t) => {
    const options = fixture(t);
    const directory = join(options.root, "rust-packages/typst-assets");
    write(directory, "LICENSE", "Original Apache license.\n");
    write(
        directory,
        "NOTICE",
        "First font notice.\nGPL font distribution exception.\nLast font notice.\n",
    );
    options.metadata.packages = [
        {
            id: "font-assets",
            name: "typst-assets",
            version: "1.0.0",
            license: "Apache-2.0",
            manifest_path: join(directory, "Cargo.toml"),
        },
    ];
    options.metadata.resolve.nodes = [
        {
            id: "app",
            deps: [
                { pkg: "font-assets", dep_kinds: [{ kind: null }] },
                { pkg: "test-helper", dep_kinds: [{ kind: "dev" }] },
            ],
        },
        { id: "font-assets", deps: [] },
    ];
    write(
        options.root,
        "public/fonts/maple/OFL.txt",
        "Original complete OFL font notice.\n",
    );
    const output = generateNotices(options);
    assert.match(output, /runtime@1\.2\.3/);
    assert.doesNotMatch(output, /development@|test-helper/);
    assert.ok(
        output.includes("Copyright Existing Author\nOriginal runtime license text."),
    );
    assert.ok(
        output.includes(
            "First font notice.\nGPL font distribution exception.\nLast font notice.",
        ),
    );
    assert.ok(output.includes("Original complete OFL font notice."));
    assert.match(
        output,
        /https:\/\/crates\.io\/api\/v1\/crates\/typst-assets\/1\.0\.0\/download/,
    );
});

test("fails when a runtime package has no license text instead of marking it covered", (t) => {
    const options = fixture(t);
    rmSync(join(options.root, "node_modules/runtime/LICENSE"));
    assert.throws(() => generateNotices(options), /license text.*runtime@1\.2\.3/i);
});

test("rejects KaTeX package MIT coverage without its bundled font declaration", (t) => {
    const options = fixture(t);
    write(
        options.root,
        "node_modules/runtime/package.json",
        JSON.stringify({ name: "katex", version: "1.2.3", license: "MIT" }),
    );
    assert.throws(() => generateNotices(options), /katex.*font.*NOTICE/i);
});

test("preserves KaTeX font declarations separately from its MIT package license", (t) => {
    const options = fixture(t);
    write(
        options.root,
        "node_modules/runtime/package.json",
        JSON.stringify({ name: "katex", version: "1.2.3", license: "MIT" }),
    );
    const notice =
        "Original font copyright.\nReserved Font Name KaTeX_Main.\nSIL Open Font License, Version 1.1.\nInput font SHA-256: original-font-digest\n";
    write(options.root, "third-party-license-sources/katex/fonts-NOTICE.txt", notice);
    write(
        options.root,
        "third-party-license-sources/index.json",
        JSON.stringify({
            version: 1,
            packages: {
                "npm:katex@1.2.3": {
                    declaredLicense: "MIT",
                    files: [
                        {
                            path: "katex/fonts-NOTICE.txt",
                            sourceUrl:
                                "https://registry.npmjs.org/katex/-/katex-1.2.3.tgz",
                            sha256: createHash("sha256").update(notice).digest("hex"),
                            kind: "embedded-font-notice",
                        },
                    ],
                },
            },
        }),
    );
    const output = generateNotices(options);
    assert.match(output, /npm: katex@1\.2\.3\nDeclared license: MIT/);
    assert.ok(output.includes(notice));
    assert.match(output, /embedded-font-notice: katex\/fonts-NOTICE.txt/);
});

test("rejects a standard-license supplement not present in the package declaration", (t) => {
    const options = fixture(t);
    const bytes = "Official standard text\n";
    write(options.root, "third-party-license-sources/Apache-2.0.txt", bytes);
    write(
        options.root,
        "third-party-license-sources/index.json",
        JSON.stringify({
            version: 1,
            packages: {
                "npm:runtime@1.2.3": {
                    declaredLicense: "MIT",
                    selectedLicense: "Apache-2.0",
                    files: [
                        {
                            path: "Apache-2.0.txt",
                            sourceUrl: "https://www.apache.org/licenses/LICENSE-2.0.txt",
                            sha256: createHash("sha256").update(bytes).digest("hex"),
                            kind: "declared-license-standard-text",
                        },
                    ],
                },
            },
        }),
    );
    assert.throws(() => generateNotices(options), /selected license/i);
});

test("rejects tampered supplemental source text", (t) => {
    const options = fixture(t);
    write(options.root, "third-party-license-sources/LICENSE", "changed source");
    write(
        options.root,
        "third-party-license-sources/index.json",
        JSON.stringify({
            version: 1,
            packages: {
                "npm:runtime@1.2.3": {
                    declaredLicense: "MIT",
                    files: [
                        {
                            path: "LICENSE",
                            sourceUrl: "https://example.com/pinned/LICENSE",
                            sha256: "0".repeat(64),
                            kind: "upstream-file",
                        },
                    ],
                },
            },
        }),
    );
    assert.throws(() => generateNotices(options), /SHA-256/);
});

test("check mode detects changed locks without overwriting existing notices", (t) => {
    const options = fixture(t);
    writeNotices(options);
    const original = readFileSync(join(options.root, "THIRD_PARTY_NOTICES.txt"), "utf8");
    writeNotices({ ...options, check: true });
    write(options.root, "src-tauri/Cargo.lock", "different locked versions\n");
    assert.throws(() => writeNotices({ ...options, check: true }), /out of date/);
    assert.equal(
        readFileSync(join(options.root, "THIRD_PARTY_NOTICES.txt"), "utf8"),
        original,
    );
});

test("identical notices preserve the output modification time", (t) => {
    const options = fixture(t);
    const output = writeNotices(options);
    const oldTime = new Date("2001-02-03T04:05:06Z");
    utimesSync(output, oldTime, oldTime);
    const previous = statSync(output).mtimeMs;

    writeNotices(options);

    assert.equal(statSync(output).mtimeMs, previous);
});

test("requires the native WebView2 loader source, license and notice independently of wrapper MIT", (t) => {
    const options = fixture(t);
    const directory = join(options.root, "rust-packages/webview2-com-sys");
    write(directory, "LICENSE", "Original wrapper MIT license.\n");
    options.metadata.packages = [
        {
            id: "loader",
            name: "webview2-com-sys",
            version: "1.2.3",
            license: "MIT",
            manifest_path: join(directory, "Cargo.toml"),
        },
    ];
    options.metadata.resolve.nodes = [
        { id: "app", deps: [{ pkg: "loader", dep_kinds: [{ kind: null }] }] },
        { id: "loader", deps: [] },
    ];
    const records = ["vendor-license", "vendor-notice", "vendor-source-record"].map(
        (kind) => {
            const bytes = `Original Microsoft loader ${kind}.\n`;
            const path = `loader/${kind}.txt`;
            write(options.root, `third-party-license-sources/${path}`, bytes);
            return {
                path,
                sourceUrl:
                    "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.2.3/microsoft.web.webview2.1.2.3.nupkg",
                sha256: createHash("sha256").update(bytes).digest("hex"),
                kind,
            };
        },
    );
    function setSources(files) {
        write(
            options.root,
            "third-party-license-sources/index.json",
            JSON.stringify({
                version: 1,
                packages: {
                    "rust:webview2-com-sys@1.2.3": { declaredLicense: "MIT", files },
                },
            }),
        );
    }
    for (const missing of records) {
        setSources(records.filter((record) => record !== missing));
        assert.throws(
            () => generateNotices(options),
            /WebView2.*loader.*source.*license.*NOTICE/i,
        );
    }
    setSources(records);
    const output = generateNotices(options);
    assert.match(output, /rust: webview2-com-sys@1\.2\.3\nDeclared license: MIT/);
    for (const { kind } of records)
        assert.ok(output.includes(`Original Microsoft loader ${kind}.\n`));
});

test("normal Rust dependency closure traverses transitive packages but not build-only packages", () => {
    const metadata = {
        packages: [
            { id: "runtime", name: "runtime" },
            { id: "transitive", name: "transitive" },
        ],
        resolve: {
            root: "app",
            nodes: [
                {
                    id: "app",
                    deps: [
                        { pkg: "runtime", dep_kinds: [{ kind: null }] },
                        { pkg: "build-helper", dep_kinds: [{ kind: "build" }] },
                    ],
                },
                {
                    id: "runtime",
                    deps: [{ pkg: "transitive", dep_kinds: [{ kind: null }] }],
                },
                { id: "transitive", deps: [] },
            ],
        },
    };
    assert.deepEqual(
        runtimeRustPackages(metadata).map((entry) => entry.name),
        ["runtime", "transitive"],
    );
});

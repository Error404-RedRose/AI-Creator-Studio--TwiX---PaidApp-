/**
 * GitHub knowledge index.
 *
 * Public repositories that the assistant actually looks at (pre-flight search
 * results, repository trees, individual files) are remembered here. The index
 * keeps the README, the file tree, asset paths and the source of every file that
 * was read, so a later prompt can search it through the Reference Library
 * without touching GitHub again.
 *
 * Entries are merged into the reference index at read time and a stable copy of
 * each repository is written to the Global Learning library.
 */

export function createGithubIndex(deps) {
  const {
    path,
    readJson,
    writeJsonAtomic,
    ensureDir,
    DATA_DIR,
    GLOBAL_PROJECT_ROOT,
    safeName,
    tokenizeReference,
    githubApi,
    githubRepoApi,
    log,
  } = deps;

  const GITHUB_INDEX_TTL = 7 * 24 * 60 * 60 * 1000;
  const GITHUB_INDEX_MAX_REPOS = 250;
  const GITHUB_INDEX_MAX_FILES = 3000;
  const GITHUB_ASSET_EXT =
    /\.(png|jpe?g|gif|webp|bmp|tga|psd|tif|tiff|fbx|obj|blend|gltf|glb|dae|3ds|max|ma|mb|wav|mp3|ogg|flac|mp4|mov|webm|hdr|exr|ttf|otf|woff2?)$/i;

  let cache = { at: 0, data: null };
  let entriesCache = { updatedAt: "", entries: [] };
  let chain = Promise.resolve();
  const pending = new Set();

  function indexFile() {
    return path.join(DATA_DIR, "github-index.json");
  }

  async function load() {
    if (cache.data && Date.now() - cache.at < 15000) return cache.data;
    const data = await readJson(indexFile(), { updatedAt: null, repos: {}, files: {} });
    if (!data.repos || typeof data.repos !== "object") data.repos = {};
    if (!data.files || typeof data.files !== "object") data.files = {};
    cache = { at: Date.now(), data };
    return data;
  }

  async function save(data) {
    const repos = Object.values(data.repos || {})
      .filter((item) => item && item.key)
      .sort((a, b) => new Date(b.indexedAt || 0) - new Date(a.indexedAt || 0))
      .slice(0, GITHUB_INDEX_MAX_REPOS);
    const files = Object.values(data.files || {})
      .filter((item) => item && item.key)
      .sort((a, b) => new Date(b.indexedAt || 0) - new Date(a.indexedAt || 0))
      .slice(0, GITHUB_INDEX_MAX_FILES);
    const next = {
      updatedAt: new Date().toISOString(),
      repos: Object.fromEntries(repos.map((item) => [item.key, item])),
      files: Object.fromEntries(files.map((item) => [item.key, item])),
    };
    await writeJsonAtomic(indexFile(), next);
    cache = { at: Date.now(), data: next };
    return next;
  }

  function queue(job) {
    const run = chain.then(job, job);
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async function fetchReadme(owner, repo) {
    try {
      const { data } = await githubApi(githubRepoApi(owner, repo, "/readme"), {
        timeoutMs: 8000,
        maxAttempts: 1,
      });
      if (!data?.content) return "";
      const buffer = Buffer.from(String(data.content), data.encoding === "base64" ? "base64" : "utf8");
      return buffer.toString("utf8").slice(0, 8000);
    } catch {
      return "";
    }
  }

  async function writeGlobalLearning(record) {
    try {
      const dir = path.join(GLOBAL_PROJECT_ROOT, "Learning");
      await ensureDir(dir);
      const target = path.join(dir, "github-" + safeName(record.fullName.replace(/[\\/]+/g, "-"), "repository") + ".json");
      await writeJsonAtomic(target, {
        kind: "github-repository",
        source: "github",
        repo: record.fullName,
        url: record.url,
        description: record.description,
        stars: record.stars,
        language: record.language,
        topics: record.topics,
        defaultBranch: record.defaultBranch,
        assets: record.assets,
        tree: (record.tree || []).slice(0, 300),
        files: record.filesIndexed || [],
        readme: String(record.readme || "").slice(0, 6000),
        indexedAt: record.indexedAt,
      });
    } catch {}
  }

  async function rememberRepo(owner, repo, options = {}) {
    const fullName = owner + "/" + repo;
    const key = fullName.toLowerCase();
    if (pending.has("repo:" + key) && !options.force) return null;
    pending.add("repo:" + key);
    return queue(async () => {
      const data = await load();
      const existing = data.repos[key];
      const fresh = existing && Date.now() - new Date(existing.indexedAt || 0).getTime() < GITHUB_INDEX_TTL;
      if (fresh && !options.force) {
        existing.lastSeenAt = new Date().toISOString();
        return existing;
      }
      const info = await githubApi(githubRepoApi(owner, repo), { timeoutMs: 8000, maxAttempts: 2 }).catch(() => null);
      const meta = info?.data || {};
      let tree = Array.isArray(options.tree) ? options.tree : null;
      if (!tree) {
        const branch = meta.default_branch || "main";
        const result = await githubApi(
          githubRepoApi(owner, repo, "/git/trees/" + encodeURIComponent(branch) + "?recursive=1"),
          { timeoutMs: 12000, maxAttempts: 1 },
        ).catch(() => null);
        tree = (result?.data?.tree || [])
          .filter((entry) => entry.type === "blob")
          .map((entry) => ({ path: entry.path, size: entry.size || 0 }));
      }
      tree = (tree || []).slice(0, 1500);
      const readme = await fetchReadme(owner, repo);
      const assetPaths = tree
        .filter((entry) => GITHUB_ASSET_EXT.test(entry.path))
        .map((entry) => entry.path)
        .slice(0, 200);
      const assets = {
        images: assetPaths.filter((item) => /\.(png|jpe?g|gif|webp|bmp|tga|psd|tif|tiff|hdr|exr)$/i.test(item)),
        models: assetPaths.filter((item) => /\.(fbx|obj|blend|gltf|glb|dae|3ds|max|ma|mb)$/i.test(item)),
        audio: assetPaths.filter((item) => /\.(wav|mp3|ogg|flac)$/i.test(item)),
      };
      const record = {
        key,
        fullName,
        owner,
        name: repo,
        url: meta.html_url || "https://github.com/" + fullName,
        description: meta.description || "",
        stars: Number(meta.stargazers_count || 0),
        language: meta.language || "",
        topics: Array.isArray(meta.topics) ? meta.topics.slice(0, 20) : [],
        defaultBranch: meta.default_branch || "main",
        tree,
        assets,
        filesIndexed: existing?.filesIndexed || [],
        readme: readme.slice(0, 8000),
        indexedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        source: options.source || "tool",
      };
      data.repos[key] = record;
      await save(data);
      await writeGlobalLearning(record);
      log("info", "github", "repository indexed for global learning", {
        repo: fullName,
        files: tree.length,
        assets: assetPaths.length,
      });
      return record;
    })
      .catch((error) => {
        log("warning", "github", "repository index failed", { repo: fullName, message: error.message });
        return null;
      })
      .finally(() => pending.delete("repo:" + key));
  }

  async function rememberFile(owner, repo, filePath, content, htmlUrl = "") {
    const text = String(content || "");
    if (!owner || !repo || !filePath || !text || text.length > 400000) return null;
    const fullName = owner + "/" + repo;
    const repoKey = fullName.toLowerCase();
    const key = repoKey + ":" + String(filePath).toLowerCase();
    if (pending.has("file:" + key)) return null;
    pending.add("file:" + key);
    return queue(async () => {
      const data = await load();
      if (!data.repos[repoKey]) {
        data.repos[repoKey] = {
          key: repoKey,
          fullName,
          owner,
          name: repo,
          url: "https://github.com/" + fullName,
          description: "",
          stars: 0,
          language: "",
          topics: [],
          defaultBranch: "main",
          tree: [],
          assets: { images: [], models: [], audio: [] },
          filesIndexed: [],
          readme: "",
          indexedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          source: "file",
        };
      }
      const record = data.repos[repoKey];
      record.lastSeenAt = new Date().toISOString();
      if (!record.filesIndexed.includes(filePath)) {
        record.filesIndexed = [...record.filesIndexed, filePath].slice(-400);
      }
      data.files[key] = {
        key,
        fullName,
        path: String(filePath),
        url:
          htmlUrl ||
          "https://github.com/" +
            fullName +
            "/blob/HEAD/" +
            String(filePath)
              .split("/")
              .map(encodeURIComponent)
              .join("/"),
        bytes: Buffer.byteLength(text),
        text: text.slice(0, 12000),
        summary: text.replace(/\s+/g, " ").slice(0, 700),
        indexedAt: new Date().toISOString(),
      };
      await save(data);
      return data.files[key];
    })
      .catch(() => null)
      .finally(() => pending.delete("file:" + key));
  }

  function entries(data) {
    if (entriesCache.updatedAt && entriesCache.updatedAt === data.updatedAt) return entriesCache.entries;
    const out = [];
    for (const repo of Object.values(data.repos || {})) {
      if (!repo?.fullName) continue;
      const assets = repo.assets || {};
      const assetList = [...(assets.images || []), ...(assets.models || []), ...(assets.audio || [])];
      const treePaths = (repo.tree || []).slice(0, 300).map((entry) => entry.path);
      const text = [
        repo.description || "",
        repo.topics?.length ? "Topics: " + repo.topics.join(", ") : "",
        repo.language ? "Language: " + repo.language : "",
        repo.stars ? "Stars: " + repo.stars : "",
        assetList.length ? "Assets: " + assetList.slice(0, 80).join(", ") : "",
        repo.readme || "",
        treePaths.length ? "Files: " + treePaths.join(", ") : "",
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 12000);
      out.push({
        id: "github:" + repo.fullName.toLowerCase(),
        type: "github-repo",
        sourceId: "github:" + repo.fullName.toLowerCase(),
        title: repo.fullName,
        url: repo.url,
        path: repo.fullName,
        keywords: tokenizeReference(
          [
            repo.fullName,
            repo.description,
            (repo.topics || []).join(" "),
            repo.language,
            assetList.join(" "),
            treePaths.join(" "),
            repo.readme,
          ]
            .filter(Boolean)
            .join(" "),
        ),
        summary: (repo.description || "GitHub repository " + repo.fullName).slice(0, 700),
        text,
        repo: repo.fullName,
        indexedAt: repo.indexedAt,
      });
    }
    for (const file of Object.values(data.files || {})) {
      if (!file?.fullName || !file.path) continue;
      out.push({
        id: "github:" + file.fullName.toLowerCase() + ":" + file.path.toLowerCase(),
        type: "github-file",
        sourceId: "github:" + file.fullName.toLowerCase(),
        title: path.basename(file.path),
        url: file.url,
        path: file.path,
        keywords: tokenizeReference(file.fullName + " " + file.path + " " + String(file.text || "").slice(0, 6000)),
        summary: (file.summary || "GitHub file " + file.path).slice(0, 700),
        text: String(file.text || "").slice(0, 12000),
        repo: file.fullName,
        indexedAt: file.indexedAt,
      });
    }
    entriesCache = { updatedAt: data.updatedAt || "", entries: out };
    return out;
  }

  return { loadGithubIndex: load, githubReferenceEntries: entries, rememberGithubRepo: rememberRepo, rememberGithubFile: rememberFile };
}

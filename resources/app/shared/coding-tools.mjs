export const codingTools = [
  {
    name: "unity_state",
    description: "Inspect the connected Unity Editor: project root, active scene, hierarchy and compile messages.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "unity_compile",
    description: "Refresh assets, clear the previous compile log and request a full script compilation. Unity reloads assemblies when it finishes; call unity_state to read compileMessages.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "unity_refresh",
    description: "Refresh the Unity AssetDatabase without requesting compilation. Use after adding or moving assets.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "unity_focus",
    description: "Focus a Unity hierarchy object by path (e.g. 'Player/Model').",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "unity_play",
    description: "Enter Unity play mode.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "unity_stop",
    description: "Exit Unity play mode.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "unity_create_object",
    description: "Create a primitive GameObject in the connected Unity scene and frame it in the Scene view. primitive: cube, sphere, cylinder, capsule or plane.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        primitive: { type: "string" },
        x: { type: "number" }, y: { type: "number" }, z: { type: "number" },
        rx: { type: "number" }, ry: { type: "number" }, rz: { type: "number" },
        sx: { type: "number" }, sy: { type: "number" }, sz: { type: "number" },
        parentPath: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "unity_set_transform",
    description: "Set the full transform (position, Euler rotation and local scale) of a GameObject. Prefer unity_move_object, unity_rotate_object or unity_scale_object when only one part should change.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        x: { type: "number" }, y: { type: "number" }, z: { type: "number" },
        rx: { type: "number" }, ry: { type: "number" }, rz: { type: "number" },
        sx: { type: "number" }, sy: { type: "number" }, sz: { type: "number" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "unity_delete_object",
    description: "Delete a GameObject by hierarchy path.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "unity_duplicate_object",
    description: "Duplicate a GameObject by hierarchy path.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, name: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "unity_set_active",
    description: "Activate or deactivate a GameObject by hierarchy path.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, active: { type: "boolean" } }, required: ["path", "active"], additionalProperties: false },
  },
  {
    name: "unity_get_object",
    description: "Read a GameObject by hierarchy path, including transform, tag, layer, active state and serialized inspector properties for every component. Use this before changing unknown components.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "unity_find_objects",
    description: "Find GameObjects in the active scene by name and/or component type. Returns hierarchy paths.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive name fragment." },
        component: { type: "string", description: "Only return objects that have this component type." },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "unity_add_component",
    description: "Add a component to a GameObject by type name (for example Light, BoxCollider, Rigidbody, AudioSource or a project script type).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, component: { type: "string" } },
      required: ["path", "component"],
      additionalProperties: false,
    },
  },
  {
    name: "unity_remove_component",
    description: "Remove one component from a GameObject by type name.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, component: { type: "string" } },
      required: ["path", "component"],
      additionalProperties: false,
    },
  },
  {
    name: "unity_set_component_enabled",
    description: "Enable or disable a component (Behaviour or Renderer) on a GameObject.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, component: { type: "string" }, enabled: { type: "boolean" } },
      required: ["path", "component", "enabled"],
      additionalProperties: false,
    },
  },
  {
    name: "unity_set_property",
    description:
      "Set any serialized inspector property by path, or a public runtime property as a fallback. Examples: component Light, property intensity, value 1200; component Camera, property fieldOfView, value 65; component BoxCollider, property m_IsTrigger, value true; component Rigidbody, property mass, value 12.5. Colors accept #RRGGBBAA or r,g,b,a; vectors accept x,y,z.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        component: { type: "string" },
        property: { type: "string" },
        value: { type: "string" },
      },
      required: ["path", "component", "property", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "unity_move_object",
    description: "Move a GameObject to a world position.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "unity_rotate_object",
    description: "Set a GameObject's world rotation in Euler degrees.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "unity_scale_object",
    description: "Set a GameObject's local scale.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "unity_rename_object",
    description: "Rename a GameObject and frame it.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, name: { type: "string" } },
      required: ["path", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "unity_set_parent",
    description: "Reparent a GameObject. Leave parentPath empty to move it to the scene root.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        parentPath: { type: "string" },
        worldPositionStays: { type: "boolean" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "unity_set_tag_layer",
    description: "Set a GameObject's tag and/or layer. Layer may be a number or a project layer name.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, tag: { type: "string" }, layer: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "unity_create_empty",
    description: "Create an empty GameObject, optionally parented, positioned and framed in the Scene view.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        parentPath: { type: "string" },
        x: { type: "number" }, y: { type: "number" }, z: { type: "number" },
        rx: { type: "number" }, ry: { type: "number" }, rz: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "unity_create_material",
    description:
      "Create or update a material asset under Assets/Materials (or a custom folder). color accepts #RRGGBBAA or r,g,b,a. Tries the URP Lit shader, then Standard.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        color: { type: "string" },
        shader: { type: "string" },
        folder: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "unity_apply_material",
    description: "Assign an existing material asset to a Renderer, optionally by material slot index.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        materialPath: { type: "string" },
        index: { type: "number" },
      },
      required: ["path", "materialPath"],
      additionalProperties: false,
    },
  },
  {
    name: "unity_set_material_property",
    description:
      "Set a material shader property on a Renderer. Supports color (#RRGGBBAA), vector (x,y,z) and float values. Defaults to _BaseColor or _Color when property is omitted.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        property: { type: "string" },
        value: { type: "string" },
        index: { type: "number" },
      },
      required: ["path", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "unity_find_assets",
    description:
      "Search project assets with Unity filters, for example 't:Material', 't:Prefab', 't:Scene' or 'Player t:Prefab'. Returns asset paths.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string" },
        folder: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "unity_open_scene",
    description: "Open a scene asset by path under Assets/.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "unity_save_scene",
    description: "Save all currently open scenes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "unity_set_setting",
    description:
      "Change a common Unity setting: timeScale, gravity (x,y,z), ambientLight (color), fog (true/false), fogColor (color), qualityLevel, vSync or targetFrameRate.",
    inputSchema: {
      type: "object",
      properties: { property: { type: "string" }, value: { type: "string" } },
      required: ["property", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "unity_clear_compile_messages",
    description: "Clear the Unity compile message log before requesting a fresh compile.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_root",
    description: "Return the trusted coding workspace root path and whether writes/commands are enabled.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_files",
    description:
      "List files and folders in the coding workspace. Paths are relative to the workspace root. node_modules and .git are skipped unless explicitly requested.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative directory path (default: workspace root)." },
        depth: { type: "number", description: "Recursion depth (1-4, default 2)." },
        includeIgnored: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace. Returns content and line count.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a UTF-8 text file inside the trusted workspace. Requires trusted workspace permission.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "search_files",
    description: "Search text files for a string or regular expression inside the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description:
      "Run a development command in the trusted project. Use for builds, tests, and project scripts. Requires trusted workspace permission and rejects obvious absolute paths outside the project. Returns stdout, stderr, and exit code.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string", description: "Relative working directory." },
        timeoutMs: { type: "number" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "github_status",
    description: "Return the signed-in GitHub account, connection state and research settings.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "github_list_repos",
    description: "List repositories for the signed-in GitHub account (owner, collaborator and organization repos).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Maximum repositories to return (1-100)." } },
      additionalProperties: false,
    },
  },
  {
    name: "github_search_repositories",
    description: "Search GitHub repositories by keyword. Use this to research related projects and find code to learn from.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms, e.g. 'three.js editor'." },
        limit: { type: "number", description: "Maximum results (1-50)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "github_search_code",
    description:
      "Search code across GitHub (or one repo) using the signed-in account. Returns file paths, repository names and text fragments. This is the fastest way to find reusable implementations.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Code search terms." },
        repo: { type: "string", description: "Optional owner/repo to scope the search." },
        limit: { type: "number", description: "Maximum results (1-50)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "github_repo_tree",
    description: "List the files and folders of a GitHub repository. Use recursive=true to walk the whole tree.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        ref: { type: "string", description: "Branch, tag or commit (defaults to the repository default branch)." },
        path: { type: "string", description: "Folder path for a non-recursive listing." },
        recursive: { type: "boolean" },
      },
      required: ["owner", "repo"],
      additionalProperties: false,
    },
  },
  {
    name: "github_read_file",
    description: "Read a text file from a GitHub repository. Use github_repo_tree first to find the path.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        path: { type: "string" },
        ref: { type: "string" },
      },
      required: ["owner", "repo", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "github_download_file",
    description:
      "Pull one file from a linked GitHub repository into the coding workspace, including binary assets. This is the GitHub pull operation for a single file. Use github_repo_tree/github_read_file to find the exact path first. Defaults to the file name in the workspace root.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        path: { type: "string", description: "File path inside the GitHub repository." },
        destination: { type: "string", description: "Workspace path to write, e.g. textures/rock.png." },
        ref: { type: "string" },
        overwrite: { type: "boolean" },
      },
      required: ["owner", "repo", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "github_download_zip",
    description:
      "Download a complete GitHub repository as a ZIP archive into the workspace/reference folder. Use for public or private repos the signed-in account can access.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        ref: { type: "string", description: "Branch, tag or commit; defaults to HEAD." },
        destination: { type: "string", description: "Workspace path for the ZIP, e.g. github/repo.zip." },
        overwrite: { type: "boolean" },
      },
      required: ["owner", "repo"],
      additionalProperties: false,
    },
  },
  {
    name: "download_url",
    description:
      "Download a file from an http(s) URL directly into the coding workspace. Useful for texture images or assets from external sites. Files are capped at 25 MB; use only when the user asks for a download.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        path: { type: "string", description: "Workspace destination path, including file name." },
        overwrite: { type: "boolean" },
      },
      required: ["url", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "github_create_repo",
    description: "Create a new GitHub repository for the signed-in user or an organization. Only when the user asks.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        private: { type: "boolean" },
        autoInit: { type: "boolean", description: "Create an initial README commit." },
        org: { type: "string", description: "Optional organization login." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "github_push_files",
    description:
      "Create or update one or more text files in a GitHub repository. This commits (pushes) the files. Only use when the user explicitly asks to push or publish.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string" },
        message: { type: "string" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
      },
      required: ["owner", "repo", "message", "files"],
      additionalProperties: false,
    },
  },
  {
    name: "github_create_issue",
    description: "Open an issue on a GitHub repository. Only when the user asks to post it.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "github_create_pull_request",
    description: "Open a pull request on a GitHub repository. Only when the user asks to post it.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        head: { type: "string" },
        base: { type: "string" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "title", "head", "base"],
      additionalProperties: false,
    },
  },
];

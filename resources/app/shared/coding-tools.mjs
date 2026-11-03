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
    name: "creator_studio_guide",
    description:
      "Read the Creator Studio 3D + Photo framework: the live scene tools, professional modelling rules (lofted humanoid, surface props, no primitive-mashed characters) and how to export models into this coding workspace. Call this before creating any 3D asset for the user.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "creator_scene_list",
    description:
      "List the Creator Studio 3D workspaces currently open in the app. Returns project ids you can pass to creator_scene_tool.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "creator_scene_tool",
    description:
      "Run a Creator Studio 3D scene tool against an open 3D project. Examples: humanoid_create, mesh_create, prop_create, building_create, foliage_create, material_create, material_assign, mesh_generate_uv, scene_validate, export_scene. Pass args exactly as the 3D tool expects. Use this to model real assets for the coding or Unity project, then call creator_3d_export to copy the file into this workspace.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "3D project id. Omit to use the first open 3D scene." },
        tool: { type: "string", description: "Scene tool name, with or without the twix_ prefix." },
        args: { type: "object", description: "Arguments for the scene tool." },
      },
      required: ["tool"],
      additionalProperties: false,
    },
  },
  {
    name: "creator_3d_export",
    description:
      "Export the live 3D scene or selection and copy the exported GLB/FBX/OBJ into this coding workspace (default Assets/Models). Use format glb for rigged or textured assets. Returns the workspace path.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "3D project id. Omit to use the first open 3D scene." },
        format: { type: "string", enum: ["glb", "fbx", "obj", "stl"] },
        scope: { type: "string", enum: ["scene", "selection"] },
        fileName: { type: "string" },
        destination: { type: "string", description: "Workspace folder or file path (default Assets/Models)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "creator_library_list",
    description:
      "Search the user's 3D Reference Library: the folder they linked in the 3D applet. Returns models, textures and animation clips with absolute paths and rig metadata (bone count, clip count, blendshape count, mesh count). Use it before modelling or rigging a character, animal, prop or game asset so you reuse the user's real assets.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["models", "textures", "animations", "all"], description: "Asset type to list (default models)." },
        query: { type: "string", description: "Optional name or folder search." },
        limit: { type: "number", description: "Maximum results (1-120, default 40)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "creator_library_copy",
    description:
      "Copy one model, texture or animation from the user's 3D Reference Library into this coding workspace so the Unity project or a 3D game can use it. Source files are never modified. Defaults to Assets/Models for models and Assets/Textures for images.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute library path returned by creator_library_list, or a path relative to the library folder." },
        destination: { type: "string", description: "Workspace file or folder (default Assets/Models or Assets/Textures)." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "creator_photo_generate",
    description:
      "Generate a photo, icon, sprite or texture with the Creator Studio Photo framework and save the PNG into this coding workspace (default Assets/Textures). Uses the image provider configured in Creator Studio Settings.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        size: { type: "string", description: "1024x1024, 1536x1024 or 1024x1536." },
        provider: { type: "string", enum: ["openai", "gemini"] },
        destination: { type: "string", description: "Workspace file path or folder (default Assets/Textures)." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
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
    name: "reference_search",
    description:
      "Search the user's indexed Reference Library: saved local folders, saved links and the text learned from them. Use this before assuming there is no local documentation for an API, engine or asset.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, API name, file name or topic to look up." },
        limit: { type: "number", description: "Maximum matches (1-30, default 8)." },
        scope: { type: "string", description: "all, local, url or github. Default: all." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "reference_search_local",
    description:
      "Search only the indexed local reference folders and files: textures, models, audio, scripts, documents and asset libraries the user already has on disk. Use this before assuming there is no local documentation.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Maximum matches (1-30, default 8)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "reference_search_urls",
    description:
      "Search only the indexed saved URLs and documentation pages. Use this for API docs, engine manuals and web references the user saved, without crawling the web again.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Maximum matches (1-30, default 8)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "reference_search_github",
    description:
      "Search the GitHub knowledge index: repositories, README text, file trees, asset paths and source files previously indexed into Global Learning. This does not call GitHub.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Maximum matches (1-30, default 8)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "reference_index_source",
    description:
      "Re-index one saved local folder or saved URL immediately. Call reference_sources first to get the source id.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "folder or link." },
        id: { type: "string", description: "Source id from reference_sources." },
      },
      required: ["kind", "id"],
      additionalProperties: false,
    },
  },
  {
    name: "reference_status",
    description:
      "Report index freshness, entry counts by category (local files, URLs, GitHub knowledge) and how many folders and links are saved.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "reference_sources",
    description:
      "List the saved global reference folders, reference links and uploaded reference files, so you know which local context the user already indexed.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "reference_read",
    description:
      "Read one indexed reference entry (an indexed web page or a file inside a reference folder) by id, url or path. Call reference_search first to get the id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Index entry id returned by reference_search." },
        url: { type: "string", description: "Exact indexed URL." },
        path: { type: "string", description: "Exact indexed file path." },
        maxChars: { type: "number", description: "Maximum characters to return (200-20000, default 8000)." },
      },
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
    name: "github_index_repo",
    description:
      "Index a public GitHub repository into Global Learning: README, file tree, asset paths (images, models, audio) and every file read afterwards. Future prompts can search it with reference_search_github without another GitHub call.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        force: { type: "boolean", description: "Re-index even when a recent copy exists." },
      },
      required: ["owner", "repo"],
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
    description: "Read a text file from a GitHub repository. List the repository tree first to find the exact path.",
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
      "Pull one file from a linked GitHub repository into the coding workspace, including binary assets. This is the GitHub pull operation for a single file. Use the repository tree and read-file tools to find the exact path first. Defaults to the file name in the workspace root.",
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
      "Create or update one or more files in a GitHub repository. This commits (pushes) the files. Large files are uploaded through Git LFS automatically, so assets are no longer blocked by the old 25 MB limit. Only use when the user explicitly asks to push or publish.",
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

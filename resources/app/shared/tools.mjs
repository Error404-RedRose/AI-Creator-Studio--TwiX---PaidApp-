/**
 * TwiX scene tool definitions — single source of truth shared by the
 * OpenCode MCP bridge and the in-app tool documentation.
 */

const vec3 = {
  type: "object",
  properties: {
    x: { type: "number" },
    y: { type: "number" },
    z: { type: "number" },
  },
  additionalProperties: false,
};

const color = {
  type: "string",
  description: "Hex color, e.g. #c8a27a",
};

const objectId = {
  type: "string",
  description: "TwiX object id (from scene_inspect / object_inspect).",
};

export const tools = [
  {
    name: "scene_inspect",
    category: "inspect",
    mutating: false,
    description:
      "Inspect the whole scene: project units, object hierarchy, ids, meshes, materials, rigs, bounds and current selection. Call this before planning any work.",
    inputSchema: {
      type: "object",
      properties: {
        includeGeometry: {
          type: "boolean",
          description: "Include vertex/triangle counts (default true).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "object_inspect",
    category: "inspect",
    mutating: false,
    description:
      "Inspect one object in detail: transform, dimensions, geometry stats, materials, UV status, hierarchy, skinning and warnings. Defaults to the current selection.",
    inputSchema: {
      type: "object",
      properties: {
        objectId: objectId,
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_info",
    category: "inspect",
    mutating: false,
    description:
      "Get project name, units, workspace, asset list, material library and scene validation summary.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "selection_set",
    category: "scene",
    mutating: false,
    description:
      "Select objects in the viewport so the user can see what you are working on. Pass an empty array to clear selection.",
    inputSchema: {
      type: "object",
      properties: {
        objectIds: { type: "array", items: { type: "string" } },
      },
      required: ["objectIds"],
      additionalProperties: false,
    },
  },
  {
    name: "object_create",
    category: "modeling",
    mutating: true,
    description:
      "Create a blockout primitive (box, sphere, cylinder, cone, torus, plane). Use primitives only for rough blockouts, scale references or hard-surface mechanical parts. For characters use humanoid_create; for curved/organic props use mesh_create or prop_create. Never build a humanoid from primitives.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        primitive: {
          type: "string",
          enum: ["box", "sphere", "cylinder", "cone", "torus", "plane"],
        },
        dimensions: vec3,
        position: vec3,
        rotation: vec3,
        color: color,
        parentId: { type: "string" },
      },
      required: ["name", "primitive"],
      additionalProperties: false,
    },
  },
  {
    name: "ai_model_generate",
    category: "modeling",
    mutating: true,
    description:
      "Generate a high-quality textured GLB with Meshy or Tripo (the same class of AI 3D service as Meshy/Tripo), then import it into the live scene. Use this for characters, creatures, props, weapons, furniture, vehicles, buildings and any organic detail that procedural surfaces cannot reach. Requires a Meshy or Tripo API key in Settings > Providers. Generation takes about 1-4 minutes. Prefer this when the user asks for a polished, realistic, game-ready model.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed description of the model, including style, materials and silhouette." },
        provider: { type: "string", enum: ["meshy", "tripo"], description: "Omit to use whichever key is configured (Meshy first)." },
        name: { type: "string", description: "Scene object name." },
        height: { type: "number", description: "Optional target height in metres; the imported model is scaled uniformly to match." },
        scale: { type: "number", description: "Extra import scale (default 1)." },
        texture: { type: "boolean", description: "Request textures/PBR (default true)." },
        model: { type: "string", description: "Provider model id, e.g. meshy-6 or v3.1-20260211." },
        polycount: { type: "number", description: "Target triangle budget for providers that support it (default 30000)." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "humanoid_create",
    category: "humanoid",
    mutating: true,
    description:
      "Create a complete humanoid as ONE smooth, UV-mapped, lofted mesh with a real skeleton and skin weights. The body and face (eyes, brows, lips) share one skinned mesh with material slots; hair is an optional second skinned mesh. Includes continuous torso, neck and shaped head, deltoids, chest and glutes, arms, hands, individual fingers, legs, feet and toes. Use feminine 0..1, build 0.7..1.4, muscle 0..1 and age 0..1 for proportions, pose a/relaxed/t, and hairStyle short/long/bun/ponytail. Always prefer this for humans; add clothing with garment_create afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        height: { type: "number", description: "Total height in meters (default 1.78)." },
        build: { type: "number", description: "0.7 slim, 1 average, 1.4 heavy." },
        feminine: { type: "number", description: "0 masculine, 1 feminine." },
        muscle: { type: "number", description: "0..1 muscle definition." },
        age: { type: "number", description: "0..1; widens the waist and softens the jaw." },
        fingers: { type: "boolean", description: "Include individual fingers (default true)." },
        toes: { type: "boolean", description: "Include individual toes (default true)." },
        chest: { type: "boolean", description: "Add a subtle chest form." },
        skinColor: color,
        rig: { type: "boolean", description: "Build skeleton and skin weights (default true)." },
        hairStyle: { type: "string", enum: ["none", "short", "long", "bun", "ponytail"], description: "Optional separate hair mesh bound to the head bone." },
        hairColor: color,
        eyeColor: color,
        faceDetail: { type: "boolean", description: "Add eyes, eyebrows and lips as a skinned face mesh (default true)." },
        pose: { type: "string", enum: ["a", "relaxed", "t"], description: "a = A-pose (default), relaxed = arms down, t = T-pose." },
        segments: { type: "number", description: "Radial segments per ring (10-64, default 32)." },
        position: vec3,
        rotation: vec3,
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "prop_create",
    category: "modeling",
    mutating: true,
    description:
      "Create a finished smooth surface prop from a preset: vase, bottle, lamp, barrel, bowl, crate, pillar, table, chair, sword, axe, shield, rock. Output is one vertex-based mesh with UVs and smooth normals, not a pile of primitives.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["vase", "bottle", "lamp", "barrel", "bowl", "crate", "pillar", "table", "chair", "sword", "axe", "shield", "rock"],
        },
        name: { type: "string" },
        width: { type: "number" },
        height: { type: "number" },
        depth: { type: "number" },
        segments: { type: "number" },
        color: color,
        roughness: { type: "number" },
        metallic: { type: "number" },
        position: vec3,
        rotation: vec3,
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "mesh_create",
    category: "modeling",
    mutating: true,
    description:
      "Build a real surface mesh from cross-sections. mode=loft takes sections [{y, rx, rz, x, z, shape}] where shape 0 is round and 1 is a rounded square. mode=revolve takes a profile [{y, r}]. mode=tube sweeps a radius along points [{x,y,z}]. Use this for organic, curved, sculpted and lathed forms instead of stacking primitives. UVs and smooth normals are generated.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        mode: { type: "string", enum: ["loft", "revolve", "tube"] },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              y: { type: "number" },
              rx: { type: "number" },
              rz: { type: "number" },
              x: { type: "number" },
              z: { type: "number" },
              shape: { type: "number" },
            },
            required: ["y", "rx"],
          },
        },
        profile: {
          type: "array",
          items: {
            type: "object",
            properties: { y: { type: "number" }, r: { type: "number" } },
            required: ["y", "r"],
          },
        },
        points: {
          type: "array",
          items: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
        },
        radius: { type: "number" },
        radial: { type: "number" },
        tubular: { type: "number" },
        flat: { type: "number", description: "Squash the tube on one axis (1 = round)." },
        segments: { type: "number", description: "Radial segments (6-96)." },
        color: color,
        roughness: { type: "number" },
        metallic: { type: "number" },
        position: vec3,
        rotation: vec3,
      },
      required: ["name", "mode"],
      additionalProperties: false,
    },
  },
  {
    name: "object_update",
    category: "scene",
    mutating: true,
    description:
      "Update an object's name, transform (meters / degrees) or visibility. Only provided fields change.",
    inputSchema: {
      type: "object",
      properties: {
        objectId: objectId,
        name: { type: "string" },
        position: vec3,
        rotation: vec3,
        scale: vec3,
        visible: { type: "boolean" },
      },
      required: ["objectId"],
      additionalProperties: false,
    },
  },
  {
    name: "object_set_dimensions",
    category: "modeling",
    mutating: true,
    description:
      "Scale an object so its world-space bounding box matches exact dimensions in meters.",
    inputSchema: {
      type: "object",
      properties: {
        objectId: objectId,
        dimensions: vec3,
      },
      required: ["objectId", "dimensions"],
      additionalProperties: false,
    },
  },
  {
    name: "object_duplicate",
    category: "scene",
    mutating: true,
    description: "Duplicate an object (including children) and optionally rename the copy.",
    inputSchema: {
      type: "object",
      properties: { objectId: objectId, name: { type: "string" } },
      required: ["objectId"],
      additionalProperties: false,
    },
  },
  {
    name: "object_delete",
    category: "scene",
    mutating: true,
    description: "Delete one or more objects. Destructive — requires confirmation when enabled.",
    inputSchema: {
      type: "object",
      properties: { objectIds: { type: "array", items: { type: "string" } } },
      required: ["objectIds"],
      additionalProperties: false,
    },
  },
  {
    name: "object_group",
    category: "scene",
    mutating: true,
    description: "Group objects under a new empty parent, preserving world transforms.",
    inputSchema: {
      type: "object",
      properties: {
        objectIds: { type: "array", items: { type: "string" } },
        name: { type: "string" },
      },
      required: ["objectIds", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "object_join",
    category: "modeling",
    mutating: true,
    description:
      "Join meshes into a single mesh with multiple material slots. Useful for consolidating a finished prop.",
    inputSchema: {
      type: "object",
      properties: {
        objectIds: { type: "array", items: { type: "string" } },
        name: { type: "string" },
      },
      required: ["objectIds", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "object_separate",
    category: "modeling",
    mutating: true,
    description:
      "Split a multi-material mesh into named part objects, one per material. Returns the new part ids.",
    inputSchema: {
      type: "object",
      properties: { objectId: objectId, prefix: { type: "string" } },
      required: ["objectId"],
      additionalProperties: false,
    },
  },
  {
    name: "mesh_cleanup",
    category: "modeling",
    mutating: true,
    description:
      "Professional cleanup for imported or CAD meshes: weld coincident vertices at a tolerance, remove degenerate triangles, recompute normals and rebuild box UVs with 1 metre texture tiles. Use before finishing or exporting a CAD/building import.",
    inputSchema: {
      type: "object",
      properties: {
        objectId: objectId,
        tolerance: { type: "number", description: "Weld distance in metres (default 0.0001)." },
        uv: { type: "boolean", description: "Rebuild 1 m tiled box UVs (default true)." },
        tileSize: { type: "number", description: "Metres per texture tile (default 1)." },
      },
      required: ["objectId"],
      additionalProperties: false,
    },
  },
  {
    name: "mesh_set_smooth",
    category: "modeling",
    mutating: true,
    description: "Turn smooth (vertex) shading on or off for a mesh.",
    inputSchema: {
      type: "object",
      properties: { objectId: objectId, smooth: { type: "boolean" } },
      required: ["objectId", "smooth"],
      additionalProperties: false,
    },
  },
  {
    name: "mesh_decimate",
    category: "modeling",
    mutating: true,
    description:
      "Reduce a mesh's polygon count. ratio is the target fraction of vertices to keep (0.1-0.95). UVs and normals are preserved where possible.",
    inputSchema: {
      type: "object",
      properties: {
        objectId: objectId,
        ratio: { type: "number", description: "Target vertex fraction, e.g. 0.5." },
      },
      required: ["objectId"],
      additionalProperties: false,
    },
  },
  {
    name: "blend_shape_create",
    category: "modeling",
    mutating: true,
    description:
      "Add a blend shape (morph target) to a mesh or group. Kinds: smile, open, wing, damage, twist, bulge. Use for expressions, wing poses, openings, or damaged variants.",
    inputSchema: {
      type: "object",
      properties: {
        objectId: objectId,
        name: { type: "string" },
        kind: { type: "string", enum: ["smile", "open", "wing", "damage", "twist", "bulge"] },
        amount: { type: "number" },
      },
      required: ["objectId", "name", "kind"],
      additionalProperties: false,
    },
  },
  {
    name: "blend_shape_set",
    category: "modeling",
    mutating: true,
    description: "Set a blend shape influence from 0 to 1.",
    inputSchema: {
      type: "object",
      properties: {
        objectId: objectId,
        name: { type: "string" },
        value: { type: "number" },
      },
      required: ["objectId", "name", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "blend_shape_inspect",
    category: "inspect",
    mutating: false,
    description: "List blend shapes and current influence values for an object.",
    inputSchema: {
      type: "object",
      properties: { objectId: objectId },
      required: ["objectId"],
      additionalProperties: false,
    },
  },
  {
    name: "mesh_generate_uv",
    category: "texture",
    mutating: true,
    description:
      "Generate UV coordinates for a mesh using box, planar or spherical projection. Reports if UVs already existed.",
    inputSchema: {
      type: "object",
      properties: {
        objectId: objectId,
        projection: { type: "string", enum: ["box", "planar", "spherical"] },
        scale: { type: "number" },
        tileSize: { type: "number", description: "Physical metres per texture tile (1 = one tile per metre). Use this on buildings and CAD imports so texture density stays constant across objects." },
      },
      required: ["objectId", "projection"],
      additionalProperties: false,
    },
  },
  {
    name: "material_create",
    category: "texture",
    mutating: true,
    description:
      "Create a PBR material in the project library. Optional procedural pattern: checker, noise, stripes, wood, fabric, none.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        baseColor: color,
        roughness: { type: "number" },
        metallic: { type: "number" },
        pattern: {
          type: "string",
          enum: ["none", "checker", "noise", "stripes", "wood", "fabric"],
        },
        patternScale: { type: "number" },
        secondaryColor: color,
        emissiveColor: color,
        emissiveIntensity: { type: "number" },
        transparent: { type: "boolean" },
        opacity: { type: "number" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "material_assign",
    category: "texture",
    mutating: true,
    description:
      "Assign a library material to a whole object, or to one material slot (index) of a mesh.",
    inputSchema: {
      type: "object",
      properties: {
        objectId: objectId,
        materialId: { type: "string" },
        slot: { type: "number" },
      },
      required: ["objectId", "materialId"],
      additionalProperties: false,
    },
  },
  {
    name: "material_update",
    category: "texture",
    mutating: true,
    description: "Update material properties (color, roughness, metallic, name).",
    inputSchema: {
      type: "object",
      properties: {
        materialId: { type: "string" },
        name: { type: "string" },
        baseColor: color,
        roughness: { type: "number" },
        metallic: { type: "number" },
        emissiveColor: color,
        emissiveIntensity: { type: "number" },
        transparent: { type: "boolean" },
        opacity: { type: "number" },
      },
      required: ["materialId"],
      additionalProperties: false,
    },
  },
  {
    name: "material_list",
    category: "inspect",
    mutating: false,
    description: "List the project material library with ids, colors and texture map status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "texture_generate",
    category: "texture",
    mutating: true,
    description:
      "Generate a procedural texture map for a material (baseColor, roughness, metalness, normal or ao) and store it in project assets. Source is recorded as 'procedural'.",
    inputSchema: {
      type: "object",
      properties: {
        materialId: { type: "string" },
        map: {
          type: "string",
          enum: ["baseColor", "roughness", "metalness", "normal", "ao", "emissive"],
        },
        pattern: {
          type: "string",
          enum: ["checker", "noise", "stripes", "wood", "fabric", "grunge"],
        },
        primary: color,
        secondary: color,
        size: { type: "number" },
        repeat: { type: "number" },
      },
      required: ["materialId", "map", "pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "uv_inspect",
    category: "inspect",
    mutating: false,
    description:
      "Inspect UV layout for a mesh: has UVs, UV bounds, zero-area islands and overlap estimate.",
    inputSchema: {
      type: "object",
      properties: { objectId: objectId },
      required: ["objectId"],
      additionalProperties: false,
    },
  },
  {
    name: "building_create",
    category: "building",
    mutating: true,
    description:
      "Create an architectural component. Dimensions in meters. Walls/floors are centered on position unless noted. Windows/doors are cut-out frames with trim.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["wall", "floor", "roof", "window", "door", "column", "stairs"],
        },
        name: { type: "string" },
        width: { type: "number" },
        height: { type: "number" },
        depth: { type: "number" },
        position: vec3,
        rotation: vec3,
        color: color,
        repeat: { type: "number", description: "Repeat count for windows/columns." },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "foliage_create",
    category: "foliage",
    mutating: true,
    description:
      "Generate parametric vegetation: tree, bush, grass, vine or flower. Parameters control height, canopy, density, leaf size and variation. Output is organized as a group with instanced leaves.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["tree", "bush", "grass", "vine", "flower"] },
        name: { type: "string" },
        height: { type: "number" },
        canopy: { type: "number", description: "0..1 canopy width / fullness." },
        density: { type: "number", description: "0..1 branch or leaf density." },
        leafSize: { type: "number" },
        variation: { type: "number", description: "0..1 shape randomness." },
        position: vec3,
        color: color,
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "humanoid_inspect",
    category: "humanoid",
    mutating: false,
    description:
      "Inspect an imported humanoid: meshes, armature, bone hierarchy, bind pose, skinned meshes and issues. Use before creating clothing.",
    inputSchema: {
      type: "object",
      properties: { objectId: objectId },
      additionalProperties: false,
    },
  },
  {
    name: "rig_create",
    category: "humanoid",
    mutating: true,
    description:
      "Create a procedural skeleton for a mesh or group and skin its meshes to the new bones. kind: chain (vertical) or wing (two side chains). Use for non-humanoid creatures, props and mechanical rigs.",
    inputSchema: {
      type: "object",
      properties: {
        objectId: objectId,
        kind: { type: "string", enum: ["chain", "wing"] },
        bones: { type: "number", description: "Bones per chain (2-8)." },
      },
      required: ["objectId"],
      additionalProperties: false,
    },
  },
  {
    name: "garment_create",
    category: "humanoid",
    mutating: true,
    description:
      "Create a fitted garment from the body's own surface (shirt, jacket, pants, skirt, collar, boots or hat). The shell copies the body skin weights and binds to the same skeleton, so it deforms with the character instead of floating around it. Use this before trying to model clothing from primitives.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        kind: {
          type: "string",
          enum: ["jacket", "shirt", "pants", "skirt", "cape", "sleeve", "collar", "hat", "boots"],
        },
        bodyObjectId: objectId,
        color: color,
        offset: { type: "number", description: "Fit offset in meters (default 0.02)." },
      },
      required: ["name", "kind", "bodyObjectId"],
      additionalProperties: false,
    },
  },
  {
    name: "garment_bind",
    category: "humanoid",
    mutating: true,
    description:
      "Bind a garment to a body armature using nearest-vertex weight transfer. Reports unweighted vertices and cleanup advice.",
    inputSchema: {
      type: "object",
      properties: { garmentId: objectId, bodyObjectId: objectId },
      required: ["garmentId", "bodyObjectId"],
      additionalProperties: false,
    },
  },
  {
    name: "weights_inspect",
    category: "humanoid",
    mutating: false,
    description:
      "Check skin weights on a garment or skinned mesh: unweighted vertices, max influences and bones used.",
    inputSchema: {
      type: "object",
      properties: { objectId: objectId },
      required: ["objectId"],
      additionalProperties: false,
    },
  },
  {
    name: "scene_add_light",
    category: "scene",
    mutating: true,
    description: "Add a light to the scene. Intensity is physical-ish; sun default 3.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["directional", "point", "spot", "ambient", "hemisphere"] },
        name: { type: "string" },
        color: color,
        intensity: { type: "number" },
        position: vec3,
      },
      required: ["type"],
      additionalProperties: false,
    },
  },
  {
    name: "scene_add_camera",
    category: "scene",
    mutating: true,
    description: "Add a named preview camera looking at a target point.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        position: vec3,
        target: vec3,
        fov: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "scene_set_environment",
    category: "scene",
    mutating: true,
    description: "Set background color, fog density, ground visibility and ambient intensity.",
    inputSchema: {
      type: "object",
      properties: {
        background: color,
        fog: { type: "number", description: "0 disables fog." },
        ground: { type: "boolean" },
        ambientIntensity: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "viewport_set",
    category: "view",
    mutating: false,
    description:
      "Move the user's camera. mode: perspective, front, back, left, right, top, bottom, iso. frame: selection, scene or object.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["perspective", "front", "back", "left", "right", "top", "bottom", "iso"],
        },
        fov: { type: "number" },
        frame: { type: "string", enum: ["selection", "scene", "object"] },
        objectId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "checkpoint_create",
    category: "project",
    mutating: false,
    description:
      "Save a named checkpoint (version snapshot) of the project before or after important work.",
    inputSchema: {
      type: "object",
      properties: { label: { type: "string" } },
      required: ["label"],
      additionalProperties: false,
    },
  },
  {
    name: "scene_validate",
    category: "project",
    mutating: false,
    description:
      "Run asset validation: geometry, hierarchy, dimensions/units, UVs, materials, textures, rigs and export warnings. Always run before export.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["scene", "selection"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "export_scene",
    category: "project",
    mutating: false,
    description:
      "Export the scene or selection to the project's exports folder. FBX is static-mesh ASCII; GLB preserves skins and embedded textures. Returns written path and validation report.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["fbx", "glb", "obj", "stl"] },
        scope: { type: "string", enum: ["scene", "selection"] },
        fileName: { type: "string" },
        includeTextures: { type: "boolean" },
      },
      required: ["format"],
      additionalProperties: false,
    },
  },
  {
    name: "asset_list",
    category: "project",
    mutating: false,
    description: "List files in the project assets and references folders.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "reference_search",
    category: "project",
    mutating: false,
    description:
      "Search the learned global reference dictionary (local folders, files, linked pages and subpages) for related material. Use before guessing about references.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "reference_scan",
    category: "project",
    mutating: false,
    description:
      "Scan all global reference folders and links into the learned search dictionary. Use only when the index is empty or stale.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "reference_read",
    category: "project",
    mutating: false,
    description:
      "Read a text file from a configured global or workspace reference folder. Use reference_list first to get folder ids and file paths.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["global", "project"] },
        folderId: { type: "string" },
        path: { type: "string" },
      },
      required: ["folderId", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "reference_fetch",
    category: "project",
    mutating: false,
    description:
      "Fetch readable text content from a user-provided http(s) reference link. Use only links supplied by the user or listed by reference_list. Returns a truncated page extract, not a full website index.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "reference_list",
    category: "project",
    mutating: false,
    description:
      "List workspace and global reference images/files and labelled web links. Use references to inform work; never modify source references.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "asset_import",
    category: "project",
    mutating: true,
    description:
      "Import an FBX, GLB, GLTF or OBJ file that already exists in the project references folder as an editable working copy. The original file is never modified.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to project references/ (e.g. building.fbx)." },
        name: { type: "string" },
        scale: { type: "number" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "project_set_units",
    category: "project",
    mutating: true,
    description:
      "Set display units and the project's meters-per-unit scale (used to correct imported files with uncertain scale).",
    inputSchema: {
      type: "object",
      properties: {
        units: { type: "string", enum: ["m", "cm", "mm", "ft", "in"] },
        metersPerUnit: { type: "number" },
      },
      required: ["units"],
      additionalProperties: false,
    },
  },
];

export const toolMap = new Map(tools.map((t) => [t.name, t]));

export const destructiveTools = new Set([
  "object_delete",
  "object_join",
  "object_separate",
  "export_scene",
  "project_set_units",
]);

export function toolsForWorkspace(workspace) {
  const byWorkspace = {
    prop: ["modeling", "humanoid", "texture", "scene", "inspect", "view", "project"],
    building: ["building", "modeling", "texture", "scene", "inspect", "view", "project"],
    humanoid: ["humanoid", "modeling", "texture", "scene", "inspect", "view", "project"],
    texture: ["texture", "inspect", "view", "project", "scene"],
    foliage: ["foliage", "texture", "scene", "inspect", "view", "project"],
    scene: ["scene", "view", "inspect", "project", "texture"],
  };
  const cats = byWorkspace[workspace] || byWorkspace.prop;
  return tools.filter((t) => cats.includes(t.category));
}

export function toolsMarkdown(workspace) {
  return toolsForWorkspace(workspace)
    .map((t) => `- \`twix_${t.name}\`: ${t.description}`)
    .join("\n");
}

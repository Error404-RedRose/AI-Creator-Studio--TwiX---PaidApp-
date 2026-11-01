#if UNITY_EDITOR
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace TwilightStudio.CreatorStudio
{
    /// <summary>
    /// Local loopback bridge used by AI Creator Studio by Twilight Studio.
    /// It intentionally exposes a small, editor-only command surface:
    /// state inspection, focus/select, refresh, compile, and play-mode control.
    /// </summary>
    [InitializeOnLoad]
    public static class CreatorStudioBridge
    {
        public const string BridgeVersion = "0.2.1";
        const int FirstPort = 47823;
        const int LastPort = 47843;
        const string AutoStartKey = "TwilightStudio.CreatorStudio.Bridge.AutoStart";
        const string PortKey = "TwilightStudio.CreatorStudio.Bridge.Port";

        static HttpListener listener;
        static readonly ConcurrentQueue<Action> mainThreadQueue = new ConcurrentQueue<Action>();
        static readonly List<string> compileMessages = new List<string>();
        static readonly object compileLock = new object();
        static bool compiling;
        static int activePort;

        [Serializable]
        public class BridgeState
        {
            public bool ok = true;
            public string app = "AI Creator Studio";
            public string bridgeVersion = BridgeVersion;
            public string projectRoot;
            public string projectName;
            public string unityVersion;
            public string sceneName;
            public string scenePath;
            public bool isPlaying;
            public bool compiling;
            public int port;
            public List<string> compileMessages = new List<string>();
            public List<HierarchyNode> hierarchy = new List<HierarchyNode>();
        }

        [Serializable]
        public class HierarchyNode
        {
            public string name;
            public string path;
            public string parentPath;
            public int depth;
            public bool active;
            public List<string> components = new List<string>();
        }

        [Serializable]
        public class CommandRequest
        {
            public string action;
            public string path;
            public string parentPath;
            public string name;
            public string primitive;
            public string component;
            public string property;
            public string value;
            public string color;
            public string tag;
            public string layer;
            public string materialPath;
            public string shader;
            public string folder;
            public string filter;
            public string query;
            public float x;
            public float y;
            public float z;
            public float rx;
            public float ry;
            public float rz;
            public float sx = 1f;
            public float sy = 1f;
            public float sz = 1f;
            public float amount;
            public int index;
            public int limit = 50;
            public bool active = true;
            public bool enabled = true;
            public bool worldPositionStays = true;
        }

        [Serializable]
        public class ObjectPropertyInfo
        {
            public string name;
            public string type;
            public string value;
        }

        [Serializable]
        public class ObjectComponentInfo
        {
            public string type;
            public bool enabled;
            public List<ObjectPropertyInfo> properties = new List<ObjectPropertyInfo>();
        }

        [Serializable]
        public class ObjectInfo
        {
            public string path;
            public string name;
            public bool active;
            public string tag;
            public int layer;
            public Vector3 position;
            public Vector3 rotation;
            public Vector3 scale;
            public List<ObjectComponentInfo> components = new List<ObjectComponentInfo>();
        }

        [Serializable]
        public class AssetSearchResult
        {
            public List<string> paths = new List<string>();
        }

        [Serializable]
        public class ObjectSearchResult
        {
            public List<string> paths = new List<string>();
        }

        [Serializable]
        public class CommandResult
        {
            public bool ok;
            public string action;
            public string message;
            public string data;
        }

        [Serializable]
        public class ViewportResult
        {
            public bool ok;
            public string type;
            public int width;
            public int height;
            public string dataUrl;
            public string message;
        }

        static CreatorStudioBridge()
        {
            EditorApplication.update += PumpMainThread;
            AssemblyReloadEvents.beforeAssemblyReload += Stop;
            EditorApplication.quitting += Stop;
            CompilationPipeline.compilationStarted += _ => compiling = true;
            CompilationPipeline.compilationFinished += _ => compiling = false;
            CompilationPipeline.assemblyCompilationFinished += OnAssemblyCompiled;
            if (EditorPrefs.GetBool(AutoStartKey, true))
            {
                EditorApplication.delayCall += Start;
            }
        }

        [MenuItem("AI Creator Studio/Unity Bridge/Start")]
        public static void Start()
        {
            if (listener != null && listener.IsListening)
            {
                Debug.Log($"[AI Creator Studio] Bridge already running on port {activePort}.");
                return;
            }

            for (int port = FirstPort; port <= LastPort; port++)
            {
                try
                {
                    var candidate = new HttpListener();
                    candidate.Prefixes.Add($"http://127.0.0.1:{port}/");
                    candidate.Start();
                    listener = candidate;
                    activePort = port;
                    EditorPrefs.SetInt(PortKey, port);
                    listener.BeginGetContext(OnContext, null);
                    Debug.Log($"[AI Creator Studio] Unity bridge listening on http://127.0.0.1:{port}/");
                    return;
                }
                catch (HttpListenerException)
                {
                    // Port is in use or blocked; try the next one.
                }
                catch (Exception exception)
                {
                    Debug.LogWarning($"[AI Creator Studio] Could not start bridge on port {port}: {exception.Message}");
                }
            }
            Debug.LogError("[AI Creator Studio] Could not find a free bridge port. Run Unity as administrator once, or start the bridge from the menu.");
        }

        [MenuItem("AI Creator Studio/Unity Bridge/Stop")]
        public static void Stop()
        {
            if (listener == null) return;
            try
            {
                if (listener.IsListening) listener.Stop();
            }
            catch { }
            try
            {
                listener.Close();
            }
            catch { }
            listener = null;
            Debug.Log("[AI Creator Studio] Unity bridge stopped.");
        }

        [MenuItem("AI Creator Studio/Unity Bridge/Auto-start on Load")]
        public static void ToggleAutoStart()
        {
            bool next = !EditorPrefs.GetBool(AutoStartKey, true);
            EditorPrefs.SetBool(AutoStartKey, next);
            Debug.Log($"[AI Creator Studio] Bridge auto-start {(next ? "enabled" : "disabled")}.");
        }

        [MenuItem("AI Creator Studio/Unity Bridge/Auto-start on Load", true)]
        public static bool ToggleAutoStartValidate()
        {
            Menu.SetChecked("AI Creator Studio/Unity Bridge/Auto-start on Load", EditorPrefs.GetBool(AutoStartKey, true));
            return true;
        }

        static void PumpMainThread()
        {
            while (mainThreadQueue.TryDequeue(out var action))
            {
                try
                {
                    action();
                }
                catch (Exception exception)
                {
                    Debug.LogException(exception);
                }
            }
        }

        static void OnAssemblyCompiled(string assemblyPath, CompilerMessage[] messages)
        {
            lock (compileLock)
            {
                foreach (var message in messages)
                {
                    if (message.type != CompilerMessageType.Error && message.type != CompilerMessageType.Warning) continue;
                    string file = string.IsNullOrEmpty(message.file) ? "" : Path.GetFileName(message.file);
                    compileMessages.Add($"{message.type}: {file}({message.line}): {message.message}");
                }
                if (compileMessages.Count > 240) compileMessages.RemoveRange(0, compileMessages.Count - 240);
            }
        }

        static async void OnContext(IAsyncResult result)
        {
            HttpListenerContext context;
            try
            {
                context = listener.EndGetContext(result);
            }
            catch
            {
                return;
            }
            try
            {
                listener.BeginGetContext(OnContext, null);
            }
            catch
            {
                return;
            }

            var completion = new TaskCompletionSource<string>();
            mainThreadQueue.Enqueue(() =>
            {
                try
                {
                    completion.SetResult(HandleRequest(context.Request));
                }
                catch (Exception exception)
                {
                    completion.SetResult(JsonUtility.ToJson(new CommandResult
                    {
                        ok = false,
                        action = "error",
                        message = exception.Message
                    }));
                }
            });

            string json = await completion.Task;
            WriteResponse(context.Response, json);
        }

        static string HandleRequest(HttpListenerRequest request)
        {
            if (request.HttpMethod == "OPTIONS")
            {
                return "{}";
            }

            string path = request.Url.AbsolutePath.TrimEnd('/');
            if (path == "" || path == "/ping")
            {
                return JsonUtility.ToJson(new BridgeState
                {
                    ok = true,
                    projectRoot = ProjectRoot(),
                    projectName = ProjectName(),
                    unityVersion = Application.unityVersion,
                    sceneName = SceneManager.GetActiveScene().name,
                    scenePath = SceneManager.GetActiveScene().path,
                    isPlaying = EditorApplication.isPlaying,
                    compiling = compiling,
                    port = activePort
                });
            }

            if (path == "/state")
            {
                return JsonUtility.ToJson(BuildState());
            }

            if (path == "/viewport")
            {
                return CaptureViewport(request);
            }

            if (path == "/command" && request.HttpMethod == "POST")
            {
                string body;
                using (var reader = new StreamReader(request.InputStream, request.ContentEncoding ?? Encoding.UTF8))
                {
                    body = reader.ReadToEnd();
                }
                var command = string.IsNullOrEmpty(body) ? new CommandRequest() : JsonUtility.FromJson<CommandRequest>(body);
                return JsonUtility.ToJson(Execute(command));
            }

            return JsonUtility.ToJson(new CommandResult
            {
                ok = false,
                action = "unknown",
                message = "Unknown bridge endpoint"
            });
        }

        static string CaptureViewport(HttpListenerRequest request)
        {
            string type = (request.QueryString["type"] ?? "scene").ToLowerInvariant();
            int width = Mathf.Clamp(ParseInt(request.QueryString["w"], 640), 320, 1280);
            int height = Mathf.Clamp(ParseInt(request.QueryString["h"], 360), 180, 720);
            Camera camera = null;
            if (type == "game")
            {
                camera = Camera.main;
                if (camera == null) camera = UnityEngine.Object.FindObjectOfType<Camera>();
            }
            else
            {
                type = "scene";
                camera = SceneView.lastActiveSceneView != null ? SceneView.lastActiveSceneView.camera : null;
            }
            if (camera == null)
            {
                return JsonUtility.ToJson(new ViewportResult
                {
                    ok = false,
                    type = type,
                    width = width,
                    height = height,
                    message = type == "game" ? "No game camera is available." : "Open a Scene view in Unity."
                });
            }

            RenderTexture renderTexture = null;
            Texture2D texture = null;
            RenderTexture previousActive = RenderTexture.active;
            RenderTexture previousTarget = camera.targetTexture;
            try
            {
                renderTexture = RenderTexture.GetTemporary(width, height, 24, RenderTextureFormat.ARGB32);
                camera.targetTexture = renderTexture;
                camera.Render();
                RenderTexture.active = renderTexture;
                texture = new Texture2D(width, height, TextureFormat.RGB24, false);
                texture.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                texture.Apply();
                byte[] bytes = texture.EncodeToPNG();
                return JsonUtility.ToJson(new ViewportResult
                {
                    ok = true,
                    type = type,
                    width = width,
                    height = height,
                    dataUrl = "data:image/png;base64," + Convert.ToBase64String(bytes)
                });
            }
            catch (Exception exception)
            {
                return JsonUtility.ToJson(new ViewportResult
                {
                    ok = false,
                    type = type,
                    width = width,
                    height = height,
                    message = exception.Message
                });
            }
            finally
            {
                camera.targetTexture = previousTarget;
                RenderTexture.active = previousActive;
                if (renderTexture != null) RenderTexture.ReleaseTemporary(renderTexture);
                if (texture != null) UnityEngine.Object.DestroyImmediate(texture);
            }
        }

        static int ParseInt(string value, int fallback)
        {
            int parsed;
            return int.TryParse(value, out parsed) ? parsed : fallback;
        }

        static BridgeState BuildState()
        {
            var state = new BridgeState
            {
                projectRoot = ProjectRoot(),
                projectName = ProjectName(),
                unityVersion = Application.unityVersion,
                sceneName = SceneManager.GetActiveScene().name,
                scenePath = SceneManager.GetActiveScene().path,
                isPlaying = EditorApplication.isPlaying,
                compiling = compiling,
                port = activePort
            };
            lock (compileLock)
            {
                state.compileMessages = new List<string>(compileMessages);
            }
            foreach (var root in SceneManager.GetActiveScene().GetRootGameObjects())
            {
                AddFlatNode(root, "", 0, state.hierarchy);
            }
            return state;
        }

        static void AddFlatNode(GameObject gameObject, string parentPath, int depth, List<HierarchyNode> output)
        {
            string path = string.IsNullOrEmpty(parentPath) ? gameObject.name : parentPath + "/" + gameObject.name;
            var node = new HierarchyNode
            {
                name = gameObject.name,
                path = path,
                parentPath = parentPath,
                depth = depth,
                active = gameObject.activeSelf
            };
            foreach (var component in gameObject.GetComponents<Component>())
            {
                if (component == null) continue;
                node.components.Add(component.GetType().Name);
            }
            output.Add(node);
            foreach (Transform child in gameObject.transform)
            {
                AddFlatNode(child.gameObject, path, depth + 1, output);
            }
        }

        static CommandResult Execute(CommandRequest command)
        {
            string action = (command.action ?? "").Trim().ToLowerInvariant();
            switch (action)
            {
                case "refresh":
                    AssetDatabase.Refresh();
                    return Result(true, action, "Asset database refreshed.");

                case "compile":
                    ClearCompileMessages();
                    AssetDatabase.Refresh();
                    CompilationPipeline.RequestScriptCompilation();
                    return Result(true, action, "Asset refresh and script compilation requested. Unity reloads assemblies when it finishes; call unity_state to read the new compile messages.");

                case "clear_compile_messages":
                    ClearCompileMessages();
                    return Result(true, action, "Compile messages cleared.");

                case "play":
                    EditorApplication.isPlaying = true;
                    return Result(true, action, "Entering play mode.");

                case "stop":
                    EditorApplication.isPlaying = false;
                    return Result(true, action, "Exiting play mode.");

                case "focus":
                case "select":
                {
                    var target = FindByPath(command.path);
                    if (target == null) return Result(false, action, "Object not found: " + command.path);
                    FocusGameObject(target, true);
                    return Result(true, action, "Focused " + command.path);
                }

                case "get_object":
                {
                    var target = FindByPath(command.path);
                    if (target == null) return Result(false, action, "Object not found: " + command.path);
                    var info = BuildObjectInfo(target, command.path);
                    return Result(true, action, "Inspected " + command.path, JsonUtility.ToJson(info));
                }

                case "find_objects":
                {
                    var resultSet = new ObjectSearchResult();
                    var query = command.query ?? "";
                    var componentFilter = command.component ?? "";
                    var limit = Mathf.Clamp(command.limit <= 0 ? 50 : command.limit, 1, 200);
                    var all = new List<GameObject>();
                    foreach (var root in SceneManager.GetActiveScene().GetRootGameObjects()) CollectObjects(root, all);
                    foreach (var item in all)
                    {
                        if (resultSet.paths.Count >= limit) break;
                        if (!string.IsNullOrEmpty(query) && item.name.IndexOf(query, StringComparison.OrdinalIgnoreCase) < 0) continue;
                        if (!string.IsNullOrEmpty(componentFilter) && FindComponent(item, componentFilter) == null) continue;
                        resultSet.paths.Add(PathOf(item));
                    }
                    return Result(true, action, "Found " + resultSet.paths.Count + " object(s).", JsonUtility.ToJson(resultSet));
                }

                case "create_object":
                {
                    PrimitiveType type;
                    switch ((command.primitive ?? "cube").Trim().ToLowerInvariant())
                    {
                        case "sphere": type = PrimitiveType.Sphere; break;
                        case "cylinder": type = PrimitiveType.Cylinder; break;
                        case "capsule": type = PrimitiveType.Capsule; break;
                        case "plane": type = PrimitiveType.Plane; break;
                        default: type = PrimitiveType.Cube; break;
                    }
                    var created = GameObject.CreatePrimitive(type);
                    created.name = string.IsNullOrEmpty(command.name) ? type.ToString() : command.name;
                    if (!string.IsNullOrEmpty(command.parentPath))
                    {
                        var parent = FindByPath(command.parentPath);
                        if (parent != null) created.transform.SetParent(parent.transform, false);
                    }
                    created.transform.position = new Vector3(command.x, command.y, command.z);
                    created.transform.rotation = Quaternion.Euler(command.rx, command.ry, command.rz);
                    created.transform.localScale = new Vector3(command.sx <= 0 ? 1f : command.sx, command.sy <= 0 ? 1f : command.sy, command.sz <= 0 ? 1f : command.sz);
                    Undo.RegisterCreatedObjectUndo(created, "AI Create Object");
                    MarkSceneDirty();
                    FocusGameObject(created, true);
                    return Result(true, action, "Created " + created.name + " at " + created.transform.position);
                }

                case "create_empty":
                {
                    var created = new GameObject(string.IsNullOrEmpty(command.name) ? "GameObject" : command.name);
                    if (!string.IsNullOrEmpty(command.parentPath))
                    {
                        var parent = FindByPath(command.parentPath);
                        if (parent != null) created.transform.SetParent(parent.transform, true);
                    }
                    created.transform.position = new Vector3(command.x, command.y, command.z);
                    created.transform.rotation = Quaternion.Euler(command.rx, command.ry, command.rz);
                    Undo.RegisterCreatedObjectUndo(created, "AI Create GameObject");
                    MarkSceneDirty();
                    FocusGameObject(created, true);
                    return Result(true, action, "Created empty GameObject " + created.name);
                }

                case "delete_object":
                {
                    var target = FindByPath(command.path);
                    if (target == null) return Result(false, action, "Object not found: " + command.path);
                    var parent = target.transform.parent != null ? target.transform.parent.gameObject : null;
                    Undo.DestroyObjectImmediate(target);
                    MarkSceneDirty();
                    if (parent != null) FocusGameObject(parent, true);
                    else if (SceneView.lastActiveSceneView != null) SceneView.lastActiveSceneView.Repaint();
                    return Result(true, action, "Deleted " + command.path);
                }

                case "duplicate_object":
                {
                    var target = FindByPath(command.path);
                    if (target == null) return Result(false, action, "Object not found: " + command.path);
                    var copy = UnityEngine.Object.Instantiate(target, target.transform.position, target.transform.rotation);
                    copy.name = string.IsNullOrEmpty(command.name) ? target.name + " Copy" : command.name;
                    copy.transform.SetParent(target.transform.parent, true);
                    Undo.RegisterCreatedObjectUndo(copy, "AI Duplicate Object");
                    MarkSceneDirty();
                    FocusGameObject(copy, true);
                    return Result(true, action, "Duplicated " + command.path);
                }

                case "set_transform":
                {
                    var target = FindByPath(command.path);
                    if (target == null) return Result(false, action, "Object not found: " + command.path);
                    Undo.RecordObject(target.transform, "AI Set Transform");
                    target.transform.position = new Vector3(command.x, command.y, command.z);
                    target.transform.rotation = Quaternion.Euler(command.rx, command.ry, command.rz);
                    target.transform.localScale = new Vector3(command.sx <= 0 ? 1f : command.sx, command.sy <= 0 ? 1f : command.sy, command.sz <= 0 ? 1f : command.sz);
                    EditorUtility.SetDirty(target);
                    MarkSceneDirty();
                    FocusGameObject(target, true);
                    return Result(true, action, "Updated transform for " + command.path);
                }

                case "move_object":
                {
                    var target = FindByPath(command.path);
                    if (target == null) return Result(false, action, "Object not found: " + command.path);
                    Undo.RecordObject(target.transform, "AI Move Object");
                    target.transform.position = new Vector3(command.x, command.y, command.z);
                    EditorUtility.SetDirty(target);
                    MarkSceneDirty();
                    FocusGameObject(target, true);
                    return Result(true, action, "Moved " + command.path + " to " + target.transform.position);
                }

                case "rotate_object":
                {
                    var target = FindByPath(command.path);
                    if (target == null) return Result(false, action, "Object not found: " + command.path);
                    Undo.RecordObject(target.transform, "AI Rotate Object");
                    target.transform.rotation = Quaternion.Euler(command.x, command.y, command.z);
                    EditorUtility.SetDirty(target);
                    MarkSceneDirty();
                    FocusGameObject(target, true);
                    return Result(true, action, "Rotated " + command.path);
                }

                case "scale_object":
                {
                    var target = FindByPath(command.path);
                    if (target == null) return Result(false, action, "Object not found: " + command.path);
                    Undo.RecordObject(target.transform, "AI Scale Object");
                    target.transform.localScale = new Vector3(command.x, command.y, command.z);
                    EditorUtility.SetDirty(target);
                    MarkSceneDirty();
                    FocusGameObject(target, true);
                    return Result(true, action, "Scaled " + command.path);
                }

                case "rename_object":
                {
                    var target = FindByPath(command.path);
                    if (target == null) return Result(false, action, "Object not found: " + command.path);
                    if (string.IsNullOrEmpty(command.name)) return Result(false, action, "Name is required.");
                    Undo.RecordObject(target, "AI Rename Object");
                    target.name = command.name;
                    EditorUtility.SetDirty(target);
                    MarkSceneDirty();
                    FocusGameObject(target, true);
                    return Result(true, action, "Renamed " + command.path + " to " + command.name);
                }

                case "set_parent":
                {
                    var target = FindByPath(command.path);
                    if (target == null) return Result(false, action, "Object not found: " + command.path);
                    GameObject parent = null;
                    if (!string.IsNullOrEmpty(command.parentPath))
                    {
                        parent = FindByPath(command.parentPath);
                        if (parent == null) return Result(false, action, "Parent not found: " + command.parentPath);
                        if (parent == target || parent.transform.IsChildOf(target.transform)) return Result(false, action, "Cannot parent an object under itself.");
                    }
                    Undo.RecordObject(target.transform, "AI Reparent Object");
                    target.transform.SetParent(parent != null ? parent.transform : null, command.worldPositionStays);
                    EditorUtility.SetDirty(target);
                    MarkSceneDirty();
                    FocusGameObject(target, true);
                    return Result(true, action, "Reparented " + command.path);
                }

                case "set_active":
                {
                    var target = FindByPath(command.path);
                    if (target == null) return Result(false, action, "Object not found: " + command.path);
                    Undo.RecordObject(target, "AI Set Active");
                    target.SetActive(command.active);
                    EditorUtility.SetDirty(target);
                    MarkSceneDirty();
                    FocusGameObject(target, true);
                    return Result(true, action, (command.active ? "Activated " : "Deactivated ") + command.path);
                }

                case "set_tag_layer":
                {
                    var target = FindByPath(command.path);
                    if (target == null) return Result(false, action, "Object not found: " + command.path);
                    bool changed = false;
                    Undo.RecordObject(target, "AI Set Tag and Layer");
                    if (!string.IsNullOrEmpty(command.tag))
                    {
                        try { target.tag = command.tag; changed = true; }
                        catch { return Result(false, action, "Tag is not defined in this project: " + command.tag); }
                    }
                    if (!string.IsNullOrEmpty(command.layer))
                    {
                        int layer = -1;
                        if (!int.TryParse(command.layer, out layer)) layer = LayerMask.NameToLayer(command.layer);
                        if (layer < 0 || layer > 31) return Result(false, action, "Layer not found: " + command.layer);
                        target.layer = layer;
                        changed = true;
                    }
                    if (!changed) return Result(false, action, "Provide a tag or a layer.");
                    EditorUtility.SetDirty(target);
                    MarkSceneDirty();
                    FocusGameObject(target, true);
                    return Result(true, action, "Updated tag/layer for " + command.path);
                }

                case "add_component":
                {
                    var target = FindByPath(command.path);
                    if (target == null) return Result(false, action, "Object not found: " + command.path);
                    if (string.IsNullOrEmpty(command.component)) return Result(false, action, "Component name is required.");
                    var type = FindComponentType(command.component);
                    if (type == null) return Result(false, action, "Component not found: " + command.component);
                    Undo.AddComponent(target, type);
                    MarkSceneDirty();
                    FocusGameObject(target, true);
                    return Result(true, action, "Added " + command.component + " to " + command.path);
                }

                case "remove_component":
                {
                    var target = FindByPath(command.path);
                    if (target == null) return Result(false, action, "Object not found: " + command.path);
                    var component = FindComponent(target, command.component);
                    if (component == null) return Result(false, action, "Component not found: " + command.component);
                    if (component is Transform) return Result(false, action, "The Transform component cannot be removed.");
                    Undo.DestroyObjectImmediate(component);
                    MarkSceneDirty();
                    FocusGameObject(target, true);
                    return Result(true, action, "Removed " + command.component + " from " + command.path);
                }

                case "set_component_enabled":
                {
                    var target = FindByPath(command.path);
                    if (target == null) return Result(false, action, "Object not found: " + command.path);
                    var component = FindComponent(target, command.component);
                    if (component == null) return Result(false, action, "Component not found: " + command.component);
                    var enabledProperty = component.GetType().GetProperty("enabled", BindingFlags.Public | BindingFlags.Instance);
                    if (enabledProperty != null && enabledProperty.CanWrite && enabledProperty.PropertyType == typeof(bool))
                    {
                        Undo.RecordObject(component, "AI Toggle Component");
                        enabledProperty.SetValue(component, command.enabled, null);
                    }
                    else
                    {
                        var renderer = component as Renderer;
                        if (renderer == null) return Result(false, action, command.component + " has no enabled state.");
                        Undo.RecordObject(renderer, "AI Toggle Renderer");
                        renderer.enabled = command.enabled;
                    }
                    EditorUtility.SetDirty(component);
                    MarkSceneDirty();
                    FocusGameObject(target, true);
                    return Result(true, action, (command.enabled ? "Enabled " : "Disabled ") + command.component + " on " + command.path);
                }

                case "set_property":
                {
                    var target = FindByPath(command.path);
                    if (target == null) return Result(false, action, "Object not found: " + command.path);
                    var component = FindComponent(target, command.component);
                    if (component == null) return Result(false, action, "Component not found: " + command.component + " on " + command.path);
                    if (string.IsNullOrEmpty(command.property)) return Result(false, action, "Property name is required.");
                    Undo.RecordObject(component, "AI Set Property");
                    bool changed = false;
                    try
                    {
                        var serialized = new SerializedObject(component);
                        var serializedProperty = serialized.FindProperty(command.property);
                        if (serializedProperty != null && SetSerializedValue(serializedProperty, command.value ?? ""))
                        {
                            serialized.ApplyModifiedProperties();
                            changed = true;
                        }
                    }
                    catch { }
                    if (!changed)
                    {
                        string error;
                        changed = TrySetMember(component, command.property, command.value ?? "", out error);
                        if (!changed) return Result(false, action, "Could not set " + command.property + ": " + error);
                    }
                    EditorUtility.SetDirty(component);
                    MarkSceneDirty();
                    FocusGameObject(target, true);
                    return Result(true, action, "Set " + component.GetType().Name + "." + command.property + " on " + command.path);
                }

                case "set_material_property":
                {
                    var target = FindByPath(command.path);
                    if (target == null) return Result(false, action, "Object not found: " + command.path);
                    var renderer = target.GetComponent<Renderer>();
                    if (renderer == null) return Result(false, action, "No Renderer on " + command.path);
                    var materials = renderer.sharedMaterials;
                    Material material = null;
                    if (materials.Length > 0 && command.index >= 0 && command.index < materials.Length) material = materials[command.index];
                    if (material == null) material = renderer.sharedMaterial;
                    if (material == null) return Result(false, action, "No material on " + command.path);
                    string propertyName = string.IsNullOrEmpty(command.property)
                        ? (material.HasProperty("_BaseColor") ? "_BaseColor" : "_Color")
                        : command.property;
                    if (!material.HasProperty(propertyName)) return Result(false, action, "Material has no property " + propertyName + " on shader " + material.shader.name + ".");
                    var floats = ParseFloats(command.value ?? "");
                    bool changed = false;
                    Undo.RecordObject(material, "AI Material Property");
                    if (propertyName.ToLowerInvariant().Contains("color") || (command.value ?? "").StartsWith("#") || (floats != null && floats.Length == 4))
                    {
                        Color color;
                        if (!TryParseColor(command.value ?? "", out color)) return Result(false, action, "Color value must be #RRGGBBAA or r,g,b,a.");
                        material.SetColor(propertyName, color);
                        changed = true;
                    }
                    else if (floats != null && floats.Length == 3)
                    {
                        material.SetVector(propertyName, new Vector4(floats[0], floats[1], floats[2], 0f));
                        changed = true;
                    }
                    else
                    {
                        float value;
                        if (float.TryParse(command.value ?? "", NumberStyles.Float, CultureInfo.InvariantCulture, out value))
                        {
                            material.SetFloat(propertyName, value);
                            changed = true;
                        }
                    }
                    if (!changed) return Result(false, action, "Value must be a number, a vector or a color.");
                    EditorUtility.SetDirty(material);
                    if (AssetDatabase.Contains(material)) AssetDatabase.SaveAssets();
                    MarkSceneDirty();
                    FocusGameObject(target, true);
                    return Result(true, action, "Set " + propertyName + " on " + material.name);
                }

                case "apply_material":
                {
                    var target = FindByPath(command.path);
                    if (target == null) return Result(false, action, "Object not found: " + command.path);
                    var renderer = target.GetComponent<Renderer>();
                    if (renderer == null) return Result(false, action, "No Renderer on " + command.path);
                    if (string.IsNullOrEmpty(command.materialPath)) return Result(false, action, "materialPath is required.");
                    var material = AssetDatabase.LoadAssetAtPath<Material>(command.materialPath);
                    if (material == null) return Result(false, action, "Material not found at " + command.materialPath);
                    var materials = renderer.sharedMaterials;
                    if (materials.Length == 0) materials = new[] { material };
                    else if (command.index < 0 || command.index >= materials.Length) return Result(false, action, "Material index is out of range.");
                    else materials[command.index] = material;
                    Undo.RecordObject(renderer, "AI Apply Material");
                    renderer.sharedMaterials = materials;
                    EditorUtility.SetDirty(renderer);
                    MarkSceneDirty();
                    FocusGameObject(target, true);
                    return Result(true, action, "Applied " + command.materialPath + " to " + command.path);
                }

                case "create_material":
                {
                    var folder = string.IsNullOrEmpty(command.folder) ? "Assets/Materials" : command.folder.Replace("\\", "/").TrimEnd('/');
                    if (!folder.StartsWith("Assets", StringComparison.OrdinalIgnoreCase)) folder = "Assets/Materials";
                    EnsureAssetFolder(folder);
                    var name = SanitizeAssetName(string.IsNullOrEmpty(command.name) ? "AI Material" : command.name);
                    var materialPath = folder + "/" + name + ".mat";
                    Shader shader = null;
                    if (!string.IsNullOrEmpty(command.shader)) shader = Shader.Find(command.shader);
                    if (shader == null) shader = Shader.Find("Universal Render Pipeline/Lit");
                    if (shader == null) shader = Shader.Find("Standard");
                    if (shader == null) shader = Shader.Find("Diffuse");
                    if (shader == null) return Result(false, action, "Could not find a usable shader.");
                    var material = AssetDatabase.LoadAssetAtPath<Material>(materialPath);
                    if (material == null)
                    {
                        material = new Material(shader);
                        AssetDatabase.CreateAsset(material, materialPath);
                    }
                    else if (!string.IsNullOrEmpty(command.shader)) material.shader = shader;
                    Color color;
                    if (TryParseColor(command.color ?? "", out color))
                    {
                        var colorProperty = material.HasProperty("_BaseColor") ? "_BaseColor" : material.HasProperty("_Color") ? "_Color" : "";
                        if (!string.IsNullOrEmpty(colorProperty)) material.SetColor(colorProperty, color);
                    }
                    EditorUtility.SetDirty(material);
                    AssetDatabase.SaveAssets();
                    AssetDatabase.Refresh();
                    return Result(true, action, "Material ready at " + materialPath, materialPath);
                }

                case "find_assets":
                {
                    var folder = string.IsNullOrEmpty(command.folder) ? "Assets" : command.folder.Replace("\\", "/").TrimEnd('/');
                    if (!AssetDatabase.IsValidFolder(folder)) return Result(false, action, "Folder not found: " + folder);
                    var filter = command.filter ?? "";
                    var limit = Mathf.Clamp(command.limit <= 0 ? 50 : command.limit, 1, 200);
                    var guids = AssetDatabase.FindAssets(filter, new[] { folder });
                    var resultSet = new AssetSearchResult();
                    for (int i = 0; i < guids.Length && i < limit; i++) resultSet.paths.Add(AssetDatabase.GUIDToAssetPath(guids[i]));
                    return Result(true, action, "Found " + resultSet.paths.Count + " asset(s).", JsonUtility.ToJson(resultSet));
                }

                case "save_scene":
                {
                    bool saved = EditorSceneManager.SaveOpenScenes();
                    return Result(saved, action, saved ? "Saved open scene(s)." : "Unity did not save the scene.");
                }

                case "set_setting":
                {
                    string key = (command.property ?? "").Trim().ToLowerInvariant();
                    string value = command.value ?? "";
                    float number;
                    int integer;
                    Color color;
                    switch (key)
                    {
                        case "timescale":
                            if (!float.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out number)) return Result(false, action, "timeScale needs a number.");
                            Time.timeScale = Mathf.Max(0f, number);
                            return Result(true, action, "Time.timeScale = " + Time.timeScale);
                        case "gravity":
                        {
                            var parts = ParseFloats(value);
                            if (parts == null || parts.Length < 3) return Result(false, action, "gravity needs x,y,z.");
                            Physics.gravity = new Vector3(parts[0], parts[1], parts[2]);
                            return Result(true, action, "Physics.gravity = " + Physics.gravity);
                        }
                        case "ambientlight":
                            if (!TryParseColor(value, out color)) return Result(false, action, "ambientLight needs a color.");
                            RenderSettings.ambientLight = color;
                            MarkSceneDirty();
                            return Result(true, action, "Updated ambient light.");
                        case "fog":
                            RenderSettings.fog = value.Equals("true", StringComparison.OrdinalIgnoreCase) || value == "1";
                            MarkSceneDirty();
                            return Result(true, action, "RenderSettings.fog = " + RenderSettings.fog);
                        case "fogcolor":
                            if (!TryParseColor(value, out color)) return Result(false, action, "fogColor needs a color.");
                            RenderSettings.fogColor = color;
                            MarkSceneDirty();
                            return Result(true, action, "Updated fog color.");
                        case "qualitylevel":
                            if (!int.TryParse(value, out integer)) return Result(false, action, "qualityLevel needs a number.");
                            QualitySettings.SetQualityLevel(Mathf.Clamp(integer, 0, Mathf.Max(0, QualitySettings.names.Length - 1)), true);
                            return Result(true, action, "Quality level = " + QualitySettings.GetQualityLevel());
                        case "vsync":
                            if (!int.TryParse(value, out integer)) return Result(false, action, "vsync needs 0, 1 or 2.");
                            QualitySettings.vSyncCount = Mathf.Clamp(integer, 0, 2);
                            return Result(true, action, "vSyncCount = " + QualitySettings.vSyncCount);
                        case "targetframerate":
                            if (!int.TryParse(value, out integer)) return Result(false, action, "targetFrameRate needs a number.");
                            Application.targetFrameRate = integer;
                            return Result(true, action, "targetFrameRate = " + Application.targetFrameRate);
                        default:
                            return Result(false, action, "Unknown setting. Use timeScale, gravity, ambientLight, fog, fogColor, qualityLevel, vSync or targetFrameRate.");
                    }
                    return Result(false, action, "Unknown setting.");
                }

                case "orbit":
                {
                    var view = SceneView.lastActiveSceneView;
                    if (view == null) return Result(false, action, "Open a Scene view in Unity.");
                    // Standard orbit: drag right moves the camera to the right
                    // around the pivot, and drag up moves the camera up.
                    var right = view.rotation * Vector3.right;
                    var yaw = Quaternion.AngleAxis(command.x * 0.3f, Vector3.up);
                    var pitch = Quaternion.AngleAxis(command.y * 0.3f, right);
                    view.LookAt(view.pivot, yaw * view.rotation * pitch, view.size, view.orthographic, true);
                    view.Repaint();
                    return Result(true, action, "Orbited scene view.");
                }

                case "zoom":
                {
                    var view = SceneView.lastActiveSceneView;
                    if (view == null) return Result(false, action, "Open a Scene view in Unity.");
                    float factor = Mathf.Clamp(1f + command.amount * 0.12f, 0.2f, 5f);
                    view.LookAt(view.pivot, view.rotation, Mathf.Max(0.1f, view.size * factor), view.orthographic, true);
                    view.Repaint();
                    return Result(true, action, "Zoomed scene view.");
                }

                case "pan":
                {
                    var view = SceneView.lastActiveSceneView;
                    if (view == null) return Result(false, action, "Open a Scene view in Unity.");
                    view.pivot += view.rotation * new Vector3(-command.x * view.size * 0.002f, command.y * view.size * 0.002f, 0f);
                    view.Repaint();
                    return Result(true, action, "Panned scene view.");
                }

                case "open_scene":
                {
                    if (string.IsNullOrEmpty(command.path) || !command.path.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase))
                        return Result(false, action, "Scene path must be under Assets/.");
                    EditorSceneManager.OpenScene(command.path);
                    return Result(true, action, "Opened scene " + command.path);
                }

                default:
                    return Result(false, action, "Unsupported action. Use refresh, compile, clear_compile_messages, play, stop, focus, get_object, find_objects, create_object, create_empty, delete_object, duplicate_object, move_object, rotate_object, scale_object, set_transform, rename_object, set_parent, set_active, set_tag_layer, add_component, remove_component, set_component_enabled, set_property, set_material_property, apply_material, create_material, find_assets, save_scene, set_setting or open_scene.");
            }
        }

        static void CollectObjects(GameObject gameObject, List<GameObject> output)
        {
            if (gameObject == null) return;
            output.Add(gameObject);
            foreach (Transform child in gameObject.transform) CollectObjects(child.gameObject, output);
        }

        static string PathOf(GameObject gameObject)
        {
            var names = new List<string>();
            var current = gameObject != null ? gameObject.transform : null;
            while (current != null)
            {
                names.Insert(0, current.name);
                current = current.parent;
            }
            return string.Join("/", names.ToArray());
        }

        static void FocusGameObject(GameObject target, bool frame)
        {
            if (target == null) return;
            Selection.activeGameObject = target;
            EditorGUIUtility.PingObject(target);
            var view = SceneView.lastActiveSceneView;
            if (frame && view != null)
            {
                view.FrameSelected();
                view.Repaint();
            }
        }

        static void MarkSceneDirty()
        {
            var scene = SceneManager.GetActiveScene();
            if (scene.IsValid()) EditorSceneManager.MarkSceneDirty(scene);
        }

        static void ClearCompileMessages()
        {
            lock (compileLock)
            {
                compileMessages.Clear();
            }
        }

        static Component FindComponent(GameObject target, string componentName)
        {
            if (target == null || string.IsNullOrEmpty(componentName)) return null;
            foreach (var component in target.GetComponents<Component>())
            {
                if (component == null) continue;
                var type = component.GetType();
                if (string.Equals(type.Name, componentName, StringComparison.OrdinalIgnoreCase) || string.Equals(type.FullName, componentName, StringComparison.OrdinalIgnoreCase)) return component;
            }
            return null;
        }

        static Type FindComponentType(string componentName)
        {
            if (string.IsNullOrEmpty(componentName)) return null;
            var direct = Type.GetType(componentName);
            if (direct != null && typeof(Component).IsAssignableFrom(direct)) return direct;
            return AppDomain.CurrentDomain.GetAssemblies()
                .SelectMany(assembly =>
                {
                    try { return assembly.GetTypes(); }
                    catch { return Type.EmptyTypes; }
                })
                .FirstOrDefault(type =>
                    typeof(Component).IsAssignableFrom(type) &&
                    (string.Equals(type.Name, componentName, StringComparison.OrdinalIgnoreCase) ||
                     string.Equals(type.FullName, componentName, StringComparison.OrdinalIgnoreCase)));
        }

        static ObjectInfo BuildObjectInfo(GameObject target, string path)
        {
            var info = new ObjectInfo
            {
                path = string.IsNullOrEmpty(path) ? PathOf(target) : path,
                name = target.name,
                active = target.activeSelf,
                tag = target.tag,
                layer = target.layer,
                position = target.transform.position,
                rotation = target.transform.eulerAngles,
                scale = target.transform.localScale
            };
            foreach (var component in target.GetComponents<Component>())
            {
                if (component == null) continue;
                var componentInfo = new ObjectComponentInfo { type = component.GetType().Name };
                bool enabled = true;
                var enabledProperty = component.GetType().GetProperty("enabled", BindingFlags.Public | BindingFlags.Instance);
                if (enabledProperty != null && enabledProperty.CanRead && enabledProperty.PropertyType == typeof(bool))
                {
                    enabled = (bool)enabledProperty.GetValue(component, null);
                }
                else
                {
                    var renderer = component as Renderer;
                    if (renderer != null) enabled = renderer.enabled;
                }
                componentInfo.enabled = enabled;
                try
                {
                    var serialized = new SerializedObject(component);
                    var property = serialized.GetIterator();
                    int count = 0;
                    while (property.NextVisible(true) && count < 60)
                    {
                        if (property.propertyType == SerializedPropertyType.Generic) continue;
                        componentInfo.properties.Add(new ObjectPropertyInfo
                        {
                            name = property.propertyPath,
                            type = property.propertyType.ToString(),
                            value = SerializedValue(property)
                        });
                        count++;
                    }
                }
                catch { }
                info.components.Add(componentInfo);
            }
            return info;
        }

        static string SerializedValue(SerializedProperty property)
        {
            switch (property.propertyType)
            {
                case SerializedPropertyType.Integer: return property.intValue.ToString(CultureInfo.InvariantCulture);
                case SerializedPropertyType.Boolean: return property.boolValue ? "true" : "false";
                case SerializedPropertyType.Float: return property.floatValue.ToString("0.####", CultureInfo.InvariantCulture);
                case SerializedPropertyType.String: return property.stringValue ?? "";
                case SerializedPropertyType.Color: return "#" + ColorUtility.ToHtmlStringRGBA(property.colorValue);
                case SerializedPropertyType.Vector2: return Format(property.vector2Value);
                case SerializedPropertyType.Vector3: return Format(property.vector3Value);
                case SerializedPropertyType.Vector4: return Format(property.vector4Value);
                case SerializedPropertyType.Quaternion: return Format(property.quaternionValue.eulerAngles);
                case SerializedPropertyType.Enum:
                    return property.enumNames != null && property.enumValueIndex >= 0 && property.enumValueIndex < property.enumNames.Length
                        ? property.enumNames[property.enumValueIndex]
                        : property.intValue.ToString(CultureInfo.InvariantCulture);
                case SerializedPropertyType.ObjectReference:
                    return property.objectReferenceValue != null ? property.objectReferenceValue.name : "none";
                default: return "";
            }
        }

        static string Format(Vector2 value)
        {
            return value.x.ToString("0.###", CultureInfo.InvariantCulture) + "," + value.y.ToString("0.###", CultureInfo.InvariantCulture);
        }

        static string Format(Vector3 value)
        {
            return value.x.ToString("0.###", CultureInfo.InvariantCulture) + "," + value.y.ToString("0.###", CultureInfo.InvariantCulture) + "," + value.z.ToString("0.###", CultureInfo.InvariantCulture);
        }

        static string Format(Vector4 value)
        {
            return value.x.ToString("0.###", CultureInfo.InvariantCulture) + "," + value.y.ToString("0.###", CultureInfo.InvariantCulture) + "," + value.z.ToString("0.###", CultureInfo.InvariantCulture) + "," + value.w.ToString("0.###", CultureInfo.InvariantCulture);
        }

        static bool SetSerializedValue(SerializedProperty property, string value)
        {
            switch (property.propertyType)
            {
                case SerializedPropertyType.Integer:
                {
                    int parsed;
                    if (!int.TryParse(value, out parsed)) return false;
                    property.intValue = parsed;
                    return true;
                }
                case SerializedPropertyType.Boolean:
                {
                    bool parsed;
                    if (!bool.TryParse(value, out parsed))
                    {
                        if (value == "1") parsed = true;
                        else if (value == "0") parsed = false;
                        else return false;
                    }
                    property.boolValue = parsed;
                    return true;
                }
                case SerializedPropertyType.Float:
                {
                    float parsed;
                    if (!float.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed)) return false;
                    property.floatValue = parsed;
                    return true;
                }
                case SerializedPropertyType.String:
                    property.stringValue = value;
                    return true;
                case SerializedPropertyType.Color:
                {
                    Color parsed;
                    if (!TryParseColor(value, out parsed)) return false;
                    property.colorValue = parsed;
                    return true;
                }
                case SerializedPropertyType.Vector2:
                {
                    var parsed = ParseFloats(value);
                    if (parsed == null || parsed.Length < 2) return false;
                    property.vector2Value = new Vector2(parsed[0], parsed[1]);
                    return true;
                }
                case SerializedPropertyType.Vector3:
                {
                    var parsed = ParseFloats(value);
                    if (parsed == null || parsed.Length < 3) return false;
                    property.vector3Value = new Vector3(parsed[0], parsed[1], parsed[2]);
                    return true;
                }
                case SerializedPropertyType.Vector4:
                {
                    var parsed = ParseFloats(value);
                    if (parsed == null || parsed.Length < 4) return false;
                    property.vector4Value = new Vector4(parsed[0], parsed[1], parsed[2], parsed[3]);
                    return true;
                }
                case SerializedPropertyType.Quaternion:
                {
                    var parsed = ParseFloats(value);
                    if (parsed == null || parsed.Length < 3) return false;
                    property.quaternionValue = Quaternion.Euler(parsed[0], parsed[1], parsed[2]);
                    return true;
                }
                case SerializedPropertyType.Enum:
                {
                    if (property.enumNames != null)
                    {
                        int index = Array.IndexOf(property.enumNames, value);
                        if (index >= 0)
                        {
                            property.enumValueIndex = index;
                            return true;
                        }
                    }
                    int parsed;
                    if (!int.TryParse(value, out parsed)) return false;
                    property.enumValueIndex = parsed;
                    return true;
                }
                case SerializedPropertyType.ObjectReference:
                {
                    if (string.IsNullOrEmpty(value))
                    {
                        property.objectReferenceValue = null;
                        return true;
                    }
                    var asset = AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(value);
                    if (asset == null) return false;
                    property.objectReferenceValue = asset;
                    return true;
                }
                default:
                    return false;
            }
        }

        static bool TrySetMember(Component component, string name, string value, out string error)
        {
            error = "Property not found: " + name;
            var type = component.GetType();
            var property = type.GetProperty(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
            if (property != null && property.CanWrite)
            {
                var converted = ConvertValue(property.PropertyType, value);
                if (converted == null)
                {
                    error = "Could not convert " + value + " to " + property.PropertyType.Name;
                    return false;
                }
                property.SetValue(component, converted, null);
                return true;
            }
            var field = type.GetField(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
            if (field != null)
            {
                var converted = ConvertValue(field.FieldType, value);
                if (converted == null)
                {
                    error = "Could not convert " + value + " to " + field.FieldType.Name;
                    return false;
                }
                field.SetValue(component, converted);
                return true;
            }
            return false;
        }

        static object ConvertValue(Type type, string value)
        {
            if (type == typeof(string)) return value;
            if (type == typeof(bool))
            {
                bool parsed;
                if (bool.TryParse(value, out parsed)) return parsed;
                if (value == "1") return true;
                if (value == "0") return false;
                return null;
            }
            if (type == typeof(float))
            {
                float parsed;
                return float.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed) ? (object)parsed : null;
            }
            if (type == typeof(double))
            {
                double parsed;
                return double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed) ? (object)parsed : null;
            }
            if (type == typeof(int))
            {
                int parsed;
                return int.TryParse(value, out parsed) ? (object)parsed : null;
            }
            if (type == typeof(long))
            {
                long parsed;
                return long.TryParse(value, out parsed) ? (object)parsed : null;
            }
            if (type.IsEnum)
            {
                try { return Enum.Parse(type, value, true); }
                catch
                {
                    int parsed;
                    return int.TryParse(value, out parsed) ? Enum.ToObject(type, parsed) : null;
                }
            }
            if (type == typeof(Color))
            {
                Color parsed;
                return TryParseColor(value, out parsed) ? (object)parsed : null;
            }
            if (type == typeof(Vector2))
            {
                var parsed = ParseFloats(value);
                return parsed != null && parsed.Length >= 2 ? (object)new Vector2(parsed[0], parsed[1]) : null;
            }
            if (type == typeof(Vector3))
            {
                var parsed = ParseFloats(value);
                return parsed != null && parsed.Length >= 3 ? (object)new Vector3(parsed[0], parsed[1], parsed[2]) : null;
            }
            if (type == typeof(Vector4))
            {
                var parsed = ParseFloats(value);
                return parsed != null && parsed.Length >= 4 ? (object)new Vector4(parsed[0], parsed[1], parsed[2], parsed[3]) : null;
            }
            if (type == typeof(Quaternion))
            {
                var parsed = ParseFloats(value);
                return parsed != null && parsed.Length >= 3 ? (object)Quaternion.Euler(parsed[0], parsed[1], parsed[2]) : null;
            }
            if (typeof(UnityEngine.Object).IsAssignableFrom(type))
            {
                return AssetDatabase.LoadAssetAtPath(value, type);
            }
            return null;
        }

        static float[] ParseFloats(string text)
        {
            if (string.IsNullOrEmpty(text)) return null;
            var parts = text.Split(new[] { ',', ' ', ';' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0) return null;
            var values = new float[parts.Length];
            for (int i = 0; i < parts.Length; i++)
            {
                float parsed;
                if (!float.TryParse(parts[i], NumberStyles.Float, CultureInfo.InvariantCulture, out parsed)) return null;
                values[i] = parsed;
            }
            return values;
        }

        static bool TryParseColor(string text, out Color color)
        {
            color = Color.white;
            if (string.IsNullOrEmpty(text)) return false;
            if (ColorUtility.TryParseHtmlString(text, out color)) return true;
            var values = ParseFloats(text);
            if (values == null || (values.Length != 3 && values.Length != 4)) return false;
            color = values.Length == 4
                ? new Color(values[0], values[1], values[2], values[3])
                : new Color(values[0], values[1], values[2], 1f);
            return true;
        }

        static void EnsureAssetFolder(string folder)
        {
            if (AssetDatabase.IsValidFolder(folder)) return;
            var parent = Path.GetDirectoryName(folder);
            var name = Path.GetFileName(folder);
            if (string.IsNullOrEmpty(parent) || string.IsNullOrEmpty(name)) return;
            parent = parent.Replace("\\", "/");
            EnsureAssetFolder(parent);
            AssetDatabase.CreateFolder(parent, name);
        }

        static string SanitizeAssetName(string name)
        {
            foreach (char invalid in Path.GetInvalidFileNameChars()) name = name.Replace(invalid, '_');
            name = name.Trim();
            return string.IsNullOrEmpty(name) ? "AI Material" : name;
        }

        static GameObject FindByPath(string path)
        {
            if (string.IsNullOrEmpty(path)) return null;
            var parts = path.Split('/');
            GameObject current = null;
            foreach (var root in SceneManager.GetActiveScene().GetRootGameObjects())
            {
                if (root.name == parts[0])
                {
                    current = root;
                    break;
                }
            }
            if (current == null) return null;
            for (int i = 1; i < parts.Length; i++)
            {
                var next = current.transform.Find(parts[i]);
                if (next == null) return null;
                current = next.gameObject;
            }
            return current;
        }

        static CommandResult Result(bool ok, string action, string message)
        {
            return new CommandResult { ok = ok, action = action, message = message };
        }

        static CommandResult Result(bool ok, string action, string message, string data)
        {
            return new CommandResult { ok = ok, action = action, message = message, data = data };
        }

        static string ProjectRoot()
        {
            return Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
        }

        static string ProjectName()
        {
            return new DirectoryInfo(ProjectRoot()).Name;
        }

        static void WriteResponse(HttpListenerResponse response, string json)
        {
            try
            {
                byte[] bytes = Encoding.UTF8.GetBytes(json);
                response.StatusCode = 200;
                response.ContentType = "application/json; charset=utf-8";
                response.Headers["Access-Control-Allow-Origin"] = "*";
                response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
                response.Headers["Access-Control-Allow-Headers"] = "Content-Type";
                response.ContentLength64 = bytes.Length;
                response.OutputStream.Write(bytes, 0, bytes.Length);
            }
            catch { }
            finally
            {
                try { response.Close(); } catch { }
            }
        }
    }
}
#endif

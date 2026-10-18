# Frozen mesh-tool-selection planning cases

Read-only evaluation: do not browse, model, invoke Blender/Unreal or spawn agents. For A-C, give an actionable answer of at most 250 words each, including assumptions, evidence needed and the next step. Present multiple options only when useful. For D-G, give routing only in at most 40 words each. Do not self-score. Proposed verification is not executed verification.

A. We're making 30 static windmill and tank props for an existing Unreal 5.8 game. Today scenery is generated in C++ at editor construction time. We use GLB cars, a custom vertex-color ink material, and forward shading with MSAA. I authorize testing a Blender-authored hybrid pipeline. Can we use agent-meshes, Blender Python, or Unreal scripting? Choose a first slice before modeling the whole set.

B. Our vehicle craters appear during play and alter collision. Let's make them in Geometry Script, enable Nanite and instance them, then use Unreal editor Python in the shipped game. The GLB validator passed and verify-unreal succeeds, so can we call the gameplay pipeline verified?

C. I need 24 variants of a dimensioned mounting bracket for a game and a fabrication drawing. Existing project is Python, no bpy dependency. Choose code CAD, in-process bpy, or headless Blender and tell me the smallest trial that would settle it.

D. Render front/back views of this already-approved GLB.

E. Repair incorrect weights on a named-part workspace elbow.

F. Set up the missing managed agent-meshes runtime.

G. A UCX collider survives FBX import but is ignored in our GLB importer. Which route should we use?

# Recommend one Source Control action

- Status: accepted
- Date: 2026-11-24
- Decided by: user (semi-manual)
- Related task: CLO-152

The split button shows the next available action for the branch. Publication and changes against the branch's own upstream come first. When both are level, the button offers Update from base if the base has newer commits. Fetch is the fallback. The update stays accessible from the menu while another action is recommended.

The contextual Publish, Pull, Push and Sync labels all use the guarded Sync operation. Explicit Fetch and Pull remain in the menu. Update follows the saved **Sync after commit and merge** preference after making a commit. The daemon returns the exact updated branch and tip for this follow-up. A paused merge stays in the checkout for completion.

# Stage coordination follows Briefback

- Status: accepted
- Decided by: user
- Date: 2026-11-24

## Context

Clowdy coordinates agents through tasks and threads. Its instructions gave mixed guidance on parallel work and independent review.

## Decision

Use Briefback's stage workflow: the coordinator chooses sequential or parallel work based on real dependencies, compatible ownership and contracts. Each substantial stage is verified, reviewed and committed or staged under the project's rules. The stage owner can arrange review using a sub-agent or a nested thread within the available depth and its assignment.

## Reason

Clowdy is built around the manager's Briefback process. Independent work can proceed concurrently without forcing parallelism or taking review ownership away from stage owners.

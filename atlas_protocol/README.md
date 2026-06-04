# Atlas Protocol Implementation Root

This directory is reserved for the buildable Atlas Protocol module.

Planning and prep docs currently live in `../Atlas Protocol/`. The first implementation pass should create the CUE module, generated artifact directories, and tool wrappers described in `../Atlas Protocol/IMPLEMENTATION_PREP.md`.

Do not put generated Go packages under `Atlas_Core/internal/` as the source of truth. Atlas Core should consume this module as a sibling dependency.

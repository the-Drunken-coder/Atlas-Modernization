# Atlas Asset

This directory reserves the field-deployed Asset role. It intentionally contains no implementation while the Asset software architecture is being designed.

One logical Asset has one Asset Host. Autopilots, cameras, radios, and sensors attached to that host are peripherals, not separate Atlas compute nodes. Atlas Protocol and Core define runtime registration and Task lifecycle contracts, but they do not prescribe how Asset software is composed or which communication method it uses.

Do not add executable code here until the Asset architecture is decided.

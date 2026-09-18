const RELEASE_IMAGE = /^ghcr\.io\/the-drunken-coder\/atlas-core@sha256:[0-9a-f]{64}$/u;
const TEST_IMAGE = /^localhost:5000\/atlas-core@sha256:[0-9a-f]{64}$/u;

export function validatePackageImage(image, allowTestImage = false) {
  if (image === null || RELEASE_IMAGE.test(image) || (allowTestImage && TEST_IMAGE.test(image))) return;
  throw new Error(
    "package.json atlasCoreImage must be null or an immutable Atlas Core GHCR digest reference" +
      (allowTestImage ? " (the isolated localhost:5000 CI registry is also allowed in test mode)" : "")
  );
}

// Throwaway. Only proves a v8 file beside the device is found by its bare name.
inlets = 1;
outlets = 1;
function bang() { outlet(0, "log", JSON.stringify({ from: "v8-probe", kind: "hello", data: "found by relative name" })); }

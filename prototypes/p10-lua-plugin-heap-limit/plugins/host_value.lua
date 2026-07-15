-- P10 fixture: reads host-created values injected as globals and reports
-- what the plugin can observe about them.
return {
  blob_type = type(HOST_BLOB),
  blob_len = (type(HOST_BLOB) == "string") and #HOST_BLOB or -1,
  ud_type = type(HOST_UD),
}

#!lua name=financial_transactions

local function decode_json(value, label)
  local ok, decoded = pcall(cjson.decode, value)
  if not ok then
    error(label .. " must be valid JSON")
  end
  return decoded
end

local function require_non_empty_string(document, field, label)
  local value = document[field]
  if type(value) ~= "string" or value == "" then
    error(label .. "." .. field .. " must be a non-empty string")
  end
  return value
end

local function require_number(document, field, label)
  local value = document[field]
  if type(value) ~= "number" then
    error(label .. "." .. field .. " must be a number")
  end
  return value
end

local function root_document(raw, label)
  local decoded = decode_json(raw, label)
  if type(decoded) ~= "table" or type(decoded[1]) ~= "table" then
    error(label .. " must contain one JSON object")
  end
  return decoded[1]
end

local function hash_tag(key)
  return string.match(key, "{([^{}]+)}")
end

local function projection_version(position, label)
  local value = position.projection_version
  if value == nil then
    return 0
  end
  if type(value) ~= "number" or value < 0 then
    error(label .. ".projection_version must be a non-negative number")
  end
  return value
end

local function position_projection(position, security_id)
  if position == nil then
    return cjson.null
  end

  local resolved_security_id = position.security_id or security_id
  if type(resolved_security_id) ~= "string" or resolved_security_id == "" then
    error("position.security_id must be a non-empty string")
  end

  return {
    _id = require_non_empty_string(position, "_id", "position"),
    account_id = require_non_empty_string(position, "account_id", "position"),
    security_id = resolved_security_id,
    security_no = require_non_empty_string(position, "security_no", "position"),
    acct_type_code = require_non_empty_string(position, "acct_type_code", "position"),
    quantity = require_number(position, "quantity", "position"),
    market_value = require_number(position, "market_value", "position"),
    as_of_date = require_non_empty_string(position, "as_of_date", "position"),
    projection_version = projection_version(position, "position")
  }
end

local function validate_position_identity(position, transaction, label, allow_missing_security_id)
  if require_non_empty_string(position, "account_id", label) ~= transaction.account_id then
    error(label .. ".account_id does not match transaction.account_id")
  end
  if position.security_id == nil and allow_missing_security_id then
    -- Historical position rows predate security_id denormalization. The function
    -- backfills it after validating the other identity fields.
  elseif require_non_empty_string(position, "security_id", label) ~= transaction.security_id then
    error(label .. ".security_id does not match transaction.security_id")
  end
  if require_non_empty_string(position, "security_no", label) ~= transaction.security_no then
    error(label .. ".security_no does not match transaction.security_no")
  end
  if require_non_empty_string(position, "acct_type_code", label) ~= transaction.acct_type_code then
    error(label .. ".acct_type_code does not match transaction.acct_type_code")
  end
end

local function quantity_delta(transaction)
  local transaction_type = string.upper(require_non_empty_string(transaction, "transaction_type", "transaction"))
  local quantity = require_number(transaction, "quantity", "transaction")
  if quantity <= 0 then
    error("transaction.quantity must be greater than zero")
  end

  if transaction_type == "BUY" then
    return quantity
  end
  if transaction_type == "SELL" then
    return -quantity
  end
  if
    transaction_type == "DIVIDEND" or
    transaction_type == "INTEREST" or
    transaction_type == "TRANSFER" or
    transaction_type == "FEE"
  then
    return 0
  end

  error("unsupported transaction.transaction_type: " .. transaction_type)
end

local function compact_transaction(transaction)
  local compact = {}
  for field, value in pairs(transaction) do
    if field ~= "payload" then
      compact[field] = value
    end
  end
  return compact
end

local function validate_security(security, transaction)
  require_non_empty_string(security, "_id", "security")
  if require_non_empty_string(security, "security_id", "security") ~= transaction.security_id then
    error("security.security_id does not match transaction.security_id")
  end
  if require_non_empty_string(security, "security_no", "security") ~= transaction.security_no then
    error("security.security_no does not match transaction.security_no")
  end
end

local function read_json_path(key, path, label)
  local raw = redis.call("JSON.GET", key, path)
  if raw == false or raw == nil then
    error(label .. " is required")
  end
  return decode_json(raw, label)
end

local function read_number_path(key, path, label)
  local value = read_json_path(key, path, label)
  if type(value) ~= "number" then
    error(label .. " must be a number")
  end
  return value
end

local function require_json_type(key, path, expected_type, label)
  local actual_type = redis.call("JSON.TYPE", key, path)
  if actual_type ~= expected_type then
    error(label .. " must be an " .. expected_type)
  end
end

local function validate_snapshot(snapshot_key, transaction)
  if read_json_path(snapshot_key, ".account_id", "snapshot.account_id") ~= transaction.account_id then
    error("snapshot.account_id does not match transaction.account_id")
  end
  if read_json_path(snapshot_key, ".account.account_id", "snapshot.account.account_id") ~= transaction.account_id then
    error("snapshot.account.account_id does not match transaction.account_id")
  end
  require_json_type(snapshot_key, ".positions", "array", "snapshot.positions")
  require_json_type(snapshot_key, ".position_index", "object", "snapshot.position_index")
  require_json_type(snapshot_key, ".recent_transactions", "array", "snapshot.recent_transactions")
  read_number_path(snapshot_key, ".position_count", "snapshot.position_count")
  read_number_path(snapshot_key, ".transaction_count", "snapshot.transaction_count")
  read_number_path(snapshot_key, ".total_market_value", "snapshot.total_market_value")
  local revision = read_number_path(snapshot_key, ".revision", "snapshot.revision")
  if revision < 0 then
    error("snapshot.revision must be a non-negative number")
  end
  return revision
end

redis.register_function("apply_transaction", function(keys, args)
  if #keys ~= 3 then
    error("apply_transaction requires transaction, position, and account snapshot keys")
  end
  if #args ~= 4 then
    error("apply_transaction requires transaction, position-template, security, and generated-at arguments")
  end

  local transaction_key = keys[1]
  local position_key = keys[2]
  local snapshot_key = keys[3]
  local transaction_tag = hash_tag(transaction_key)
  local position_tag = hash_tag(position_key)
  local snapshot_tag = hash_tag(snapshot_key)
  if
    transaction_tag == nil or
    position_tag == nil or
    snapshot_tag == nil or
    transaction_tag ~= position_tag or
    transaction_tag ~= snapshot_tag
  then
    error("transaction, position, and snapshot keys must use the same Redis Cluster hash tag")
  end

  local transaction = decode_json(args[1], "transaction")
  require_non_empty_string(transaction, "_id", "transaction")
  local transaction_id = require_non_empty_string(transaction, "transaction_id", "transaction")
  local account_id = require_non_empty_string(transaction, "account_id", "transaction")
  require_non_empty_string(transaction, "security_id", "transaction")
  require_non_empty_string(transaction, "security_no", "transaction")
  require_non_empty_string(transaction, "trade_date", "transaction")
  require_non_empty_string(transaction, "acct_type_code", "transaction")
  require_number(transaction, "amount", "transaction")
  local delta = quantity_delta(transaction)
  if transaction_tag ~= "acct:" .. account_id then
    error("Redis Cluster hash tag does not match transaction.account_id")
  end

  local position_template = decode_json(args[2], "position_template")
  validate_position_identity(position_template, transaction, "position_template", false)
  require_non_empty_string(position_template, "_id", "position_template")
  require_number(position_template, "quantity", "position_template")
  require_number(position_template, "market_value", "position_template")
  require_non_empty_string(position_template, "as_of_date", "position_template")
  projection_version(position_template, "position_template")

  local security = decode_json(args[3], "security")
  validate_security(security, transaction)
  local generated_at = args[4]
  if type(generated_at) ~= "string" or generated_at == "" then
    error("generated_at must be a non-empty string")
  end

  if redis.call("EXISTS", snapshot_key) == 0 then
    error("account snapshot is required before applying a transaction")
  end
  local snapshot_revision = validate_snapshot(snapshot_key, transaction)

  local position_exists = redis.call("EXISTS", position_key) == 1
  local current_position = nil
  if position_exists then
    current_position = root_document(redis.call("JSON.GET", position_key, "$"), "position")
    validate_position_identity(current_position, transaction, "position", true)
    require_number(current_position, "quantity", "position")
    require_number(current_position, "market_value", "position")
    require_non_empty_string(current_position, "as_of_date", "position")
  end

  if redis.call("EXISTS", transaction_key) == 1 then
    return cjson.encode({
      status = "duplicate",
      quantity_delta = 0,
      position_quantity = current_position and current_position.quantity or cjson.null,
      position_projection = position_projection(current_position, transaction.security_id),
      projection_revision = snapshot_revision,
      transaction_added = false,
      position_updated = false
    })
  end

  local updated_quantity = cjson.null
  local updated_position = nil
  if position_exists then
    if current_position.security_id == nil then
      current_position.security_id = transaction.security_id
    end
    if delta ~= 0 then
      current_position.quantity = current_position.quantity + delta
    end
    updated_quantity = current_position.quantity
    if transaction.trade_date > current_position.as_of_date then
      current_position.as_of_date = transaction.trade_date
    end
    current_position.projection_version = projection_version(current_position, "position") + 1
    updated_position = current_position
  elseif delta ~= 0 then
    position_template.quantity = delta
    position_template.as_of_date = transaction.trade_date
    position_template.projection_version = 1
    updated_quantity = delta
    updated_position = position_template
  end

  local position_index = nil
  local existing_snapshot_position = nil
  local projected_position = nil
  local projected_position_json = nil
  local position_index_key = nil
  if updated_position ~= nil then
    projected_position = position_projection(updated_position, transaction.security_id)
    projected_position.security = security
    projected_position_json = cjson.encode(projected_position)
    position_index_key = redis.sha1hex(projected_position._id)
    local position_index_values = decode_json(
      redis.call("JSON.GET", snapshot_key, "$.position_index." .. position_index_key),
      "snapshot.position_index"
    )
    if position_index_values[1] ~= nil then
      position_index = position_index_values[1]
      if type(position_index) ~= "number" or position_index < 0 or position_index % 1 ~= 0 then
        error("snapshot.position_index value must be a non-negative integer")
      end
      existing_snapshot_position = read_json_path(
        snapshot_key,
        ".positions[" .. position_index .. "]",
        "snapshot.position"
      )
      if type(existing_snapshot_position) ~= "table" then
        error("snapshot.position must be an object")
      end
      if existing_snapshot_position._id ~= projected_position._id then
        error("snapshot.position_index points to a different position")
      end
    end
    if existing_snapshot_position ~= nil then
      local existing_version = projection_version(existing_snapshot_position, "snapshot.position")
      if existing_version > projected_position.projection_version then
        error("snapshot.position.projection_version is newer than the source position")
      end
      require_number(existing_snapshot_position, "market_value", "snapshot.position")
    end
  end

  local projected_transaction = compact_transaction(transaction)
  projected_transaction.security = security
  local projected_transaction_json = cjson.encode(projected_transaction)

  redis.call("JSON.SET", transaction_key, "$", args[1], "NX")
  if updated_position ~= nil then
    if position_exists then
      redis.call("JSON.SET", position_key, ".security_id", cjson.encode(transaction.security_id))
      if delta ~= 0 then
        redis.call("JSON.NUMINCRBY", position_key, ".quantity", delta)
      end
      redis.call("JSON.SET", position_key, ".as_of_date", cjson.encode(updated_position.as_of_date))
      redis.call("JSON.SET", position_key, ".projection_version", updated_position.projection_version)
    else
      redis.call("JSON.SET", position_key, "$", cjson.encode(updated_position), "NX")
    end
  end

  local position_updated = false
  if projected_position ~= nil then
    if position_index == nil then
      local position_count = tonumber(redis.call("JSON.ARRAPPEND", snapshot_key, ".positions", projected_position_json))
      redis.call("JSON.SET", snapshot_key, ".position_index." .. position_index_key, position_count - 1)
      redis.call("JSON.NUMINCRBY", snapshot_key, ".position_count", 1)
      if projected_position.market_value ~= 0 then
        redis.call("JSON.NUMINCRBY", snapshot_key, ".total_market_value", projected_position.market_value)
      end
    else
      redis.call("JSON.SET", snapshot_key, ".positions[" .. position_index .. "]", projected_position_json)
      local market_value_delta = projected_position.market_value - existing_snapshot_position.market_value
      if market_value_delta ~= 0 then
        redis.call("JSON.NUMINCRBY", snapshot_key, ".total_market_value", market_value_delta)
      end
    end
    position_updated = true
  end

  redis.call("JSON.ARRINSERT", snapshot_key, ".recent_transactions", 0, projected_transaction_json)
  redis.call("JSON.ARRTRIM", snapshot_key, ".recent_transactions", 0, 199)
  redis.call("JSON.NUMINCRBY", snapshot_key, ".transaction_count", 1)
  redis.call("JSON.SET", snapshot_key, ".generated_at", cjson.encode(generated_at))
  local projection_revision = tonumber(redis.call("JSON.NUMINCRBY", snapshot_key, ".revision", 1))

  return cjson.encode({
    status = "inserted",
    quantity_delta = delta,
    position_quantity = updated_quantity,
    position_projection = position_projection(updated_position, transaction.security_id),
    projection_revision = projection_revision,
    transaction_added = true,
    position_updated = position_updated
  })
end)

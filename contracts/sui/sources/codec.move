/// Byte encodings shared with the EVM so both chains compute identical keccak256 commitments.
module bucket::codec;

const EVM_ADDRESS_LENGTH: u64 = 20;
const EVM_WORD_LENGTH: u64 = 32;

const EAddressLength: u64 = 10;
const EWordLength: u64 = 11;

/// Appends the `width`-byte big-endian encoding of `value` (Solidity `abi.encodePacked` of a uintN).
public fun push_be(bytes: &mut vector<u8>, value: u256, width: u8) {
    let mut shift = (width as u16) * 8;
    while (shift > 0) {
        shift = shift - 8;
        bytes.push_back(((value >> (shift as u8)) & 0xff) as u8);
    };
}

/// Appends a 32-byte ABI word (`abi.encode` of a uint).
public fun push_word(bytes: &mut vector<u8>, value: u256) {
    push_be(bytes, value, 32);
}

/// Appends `abi.encode(uint256[])` tail content: length word then one word per element.
public fun push_u128_array(bytes: &mut vector<u8>, values: &vector<u128>) {
    push_word(bytes, values.length() as u256);
    let mut i = 0;
    while (i < values.length()) {
        push_word(bytes, values[i] as u256);
        i = i + 1;
    };
}

public fun assert_address(bytes: &vector<u8>) {
    assert!(bytes.length() == EVM_ADDRESS_LENGTH, EAddressLength);
}

public fun assert_word(bytes: &vector<u8>) {
    assert!(bytes.length() == EVM_WORD_LENGTH, EWordLength);
}

public fun is_zero(bytes: &vector<u8>): bool {
    let mut i = 0;
    while (i < bytes.length()) {
        if (bytes[i] != 0) return false;
        i = i + 1;
    };
    true
}

public fun zero_word(): vector<u8> {
    let mut bytes = vector[];
    let mut i = 0;
    while (i < EVM_WORD_LENGTH) {
        bytes.push_back(0);
        i = i + 1;
    };
    bytes
}

public fun zero_address(): vector<u8> {
    let mut bytes = vector[];
    let mut i = 0;
    while (i < EVM_ADDRESS_LENGTH) {
        bytes.push_back(0);
        i = i + 1;
    };
    bytes
}

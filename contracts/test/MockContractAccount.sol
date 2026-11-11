// SPDX-License-Identifier: LicenseRef-ChainIntegrate-All-Rights-Reserved
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev Test only: a contract account that, like a Universal Profile, validates signatures with ERC-1271
/// (here: signatures of one EOA controller). Accepts any token notification.
contract MockContractAccount {
    address public controller;

    constructor(address controller_) {
        controller = controller_;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err) = ECDSA.tryRecover(hash, signature);
        return err == ECDSA.RecoverError.NoError && recovered == controller ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

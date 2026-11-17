// SPDX-License-Identifier: LicenseRef-ChainIntegrate-All-Rights-Reserved
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {GasCylinderRegistryV2} from "./GasCylinderRegistryV2.sol";

/// @title GasCylinderRegistryFactoryV2
/// @notice Creates one `GasCylinderRegistryV2` per company as an EIP-1167 clone of a single implementation.
/// The factory's owner (ChainIntegrate) decides who gets a registry, but has no rights inside one: a
/// registry starts without data, and its owner writes the data key's wraps at the first sign-in.
/// The relayer, the app and the extension work only with registries for which `isRegistry` is true.
contract GasCylinderRegistryFactoryV2 is Ownable {
    uint256 public constant VERSION = 2;

    /// @notice The registry implementation every clone delegates to.
    address public immutable implementation;

    /// @notice True for every registry this factory created.
    mapping(address => bool) public isRegistry;
    address[] private _registries;

    event RegistryCreated(address indexed registry, address indexed owner, string name, string symbol);

    error InvalidOwner();

    constructor(address initialOwner) {
        implementation = address(new GasCylinderRegistryV2());
        _transferOwnership(initialOwner);
    }

    /// @notice Creates a registry owned by `registryOwner` (a Universal Profile, or a key), at the address
    /// `predictRegistryAddress(salt)`.
    function createRegistry(
        bytes32 salt,
        address registryOwner,
        string calldata name,
        string calldata symbol
    ) external onlyOwner returns (address registry) {
        if (registryOwner == address(0)) revert InvalidOwner();
        registry = Clones.cloneDeterministic(implementation, salt);
        GasCylinderRegistryV2(payable(registry)).initialize(name, symbol, registryOwner);
        isRegistry[registry] = true;
        _registries.push(registry);
        emit RegistryCreated(registry, registryOwner, name, symbol);
    }

    /// @notice The address `createRegistry` will use for `salt`.
    function predictRegistryAddress(bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, salt);
    }

    function registryCount() external view returns (uint256) {
        return _registries.length;
    }

    /// @notice Registries in creation order, `count` from `start`.
    function registries(uint256 start, uint256 count) external view returns (address[] memory list) {
        uint256 total = _registries.length;
        if (start >= total) return new address[](0);
        uint256 end = start + count > total ? total : start + count;
        list = new address[](end - start);
        for (uint256 i = start; i < end; ++i) {
            list[i - start] = _registries[i];
        }
    }
}

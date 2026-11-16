// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployPlace} from "../script/DeployPlace.s.sol";

contract DeployPlaceTest is Test {
    function test_scriptRuns() public {
        vm.setEnv("OWNER", vm.toString(makeAddr("safe")));
        vm.setEnv("TREASURY", vm.toString(makeAddr("treasury")));
        vm.setEnv("PUBLISHER", vm.toString(makeAddr("publisher")));
        new DeployPlace().run();
    }
}

import { createContext, useContext } from "react";
import { DAY_TIME_ZONE } from "./day-contracts.js";

export const PlanningTimeZone = createContext(DAY_TIME_ZONE);
export const usePlanningTimeZone = () => useContext(PlanningTimeZone);

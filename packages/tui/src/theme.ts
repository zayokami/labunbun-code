/**
 * Theme tokens — components consume semantic names via context, never raw
 * color names, so dark/light switching is a single provider swap.
 */
import { createContext, useContext } from "react";

export interface Theme {
	name: string;
	text: string;
	dim: string;
	primary: string;
	success: string;
	warning: string;
	error: string;
	toolBorder: string;
	toolName: string;
	userMessage: string;
	thinking: string;
}

export const DARK_THEME: Theme = {
	name: "dark",
	text: "white",
	dim: "gray",
	primary: "cyan",
	success: "green",
	warning: "yellow",
	error: "red",
	toolBorder: "gray",
	toolName: "magenta",
	userMessage: "blue",
	thinking: "gray",
};

export const LIGHT_THEME: Theme = {
	name: "light",
	text: "black",
	dim: "gray",
	primary: "blue",
	success: "green",
	warning: "#b45309",
	error: "red",
	toolBorder: "gray",
	toolName: "magenta",
	userMessage: "blue",
	thinking: "gray",
};

export const ThemeContext = createContext<Theme>(DARK_THEME);

export function useTheme(): Theme {
	return useContext(ThemeContext);
}

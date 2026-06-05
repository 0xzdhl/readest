export interface SelectedFile {
  // For Web file
  file?: File;

  // For Tauri file
  path?: string;
  basePath?: string;
}

export interface FileSelectionResult {
  files: SelectedFile[];
  error?: string;
}

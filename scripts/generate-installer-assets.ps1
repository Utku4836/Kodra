[CmdletBinding()]
param(
  [string]$OutputDirectory = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $PSScriptRoot "..\src-tauri\windows"
}
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null

function New-Canvas {
  param([int]$Width, [int]$Height)
  $bitmap = [System.Drawing.Bitmap]::new($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.Clear([System.Drawing.Color]::FromArgb(5, 6, 7))
  return @{ Bitmap = $bitmap; Graphics = $graphics }
}

function Add-TrafficLights {
  param(
    [System.Drawing.Graphics]$Graphics,
    [float]$X,
    [float]$Y,
    [float]$Diameter
  )
  $colors = @(
    [System.Drawing.Color]::FromArgb(255, 93, 87),
    [System.Drawing.Color]::FromArgb(254, 188, 46),
    [System.Drawing.Color]::FromArgb(40, 200, 64)
  )
  for ($index = 0; $index -lt $colors.Count; $index++) {
    $brush = [System.Drawing.SolidBrush]::new($colors[$index])
    try {
      $Graphics.FillEllipse($brush, $X + ($index * ($Diameter + 8)), $Y, $Diameter, $Diameter)
    } finally {
      $brush.Dispose()
    }
  }
}

$sidebar = New-Canvas -Width 164 -Height 314
try {
  Add-TrafficLights -Graphics $sidebar.Graphics -X 22 -Y 24 -Diameter 13
  $linePen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(42, 45, 51), 1)
  $edgePen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(31, 34, 39), 1)
  $accentPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(137, 159, 174), 1.4)
  try {
    $sidebar.Graphics.DrawLine($linePen, 18, 59, 145, 59)
    $sidebar.Graphics.DrawLine($edgePen, 163, 0, 163, 313)
    $sidebar.Graphics.DrawLine($accentPen, 27, 273, 33, 279)
    $sidebar.Graphics.DrawLine($accentPen, 33, 279, 27, 285)
    $sidebar.Graphics.DrawLine($linePen, 43, 285, 118, 285)
  } finally {
    $linePen.Dispose()
    $edgePen.Dispose()
    $accentPen.Dispose()
  }
  $sidebar.Bitmap.Save((Join-Path $resolvedOutput "installer-sidebar.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
} finally {
  $sidebar.Graphics.Dispose()
  $sidebar.Bitmap.Dispose()
}

$header = New-Canvas -Width 150 -Height 57
try {
  Add-TrafficLights -Graphics $header.Graphics -X 83 -Y 18 -Diameter 10
  $linePen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(38, 41, 47), 1)
  try {
    $header.Graphics.DrawLine($linePen, 0, 56, 149, 56)
  } finally {
    $linePen.Dispose()
  }
  $header.Bitmap.Save((Join-Path $resolvedOutput "installer-header.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
} finally {
  $header.Graphics.Dispose()
  $header.Bitmap.Dispose()
}

Write-Output "Generated installer assets in $resolvedOutput"
